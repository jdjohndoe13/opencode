import path from "path"
import { measureEditText, type WidthMethod } from "@opentui/core"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { PromptInput } from "@opencode/schema"
import type { Types } from "effect"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PastedText = {
  text: string
  source: {
    start: number
    end: number
    text: string
  }
}

// `path` is the local file a pasted attachment was read from. It stays in the TUI.
export type PromptFile = Types.DeepMutable<PromptInput.FileAttachment> & { path?: string }

export type PromptInfo = Types.DeepMutable<Pick<PromptInput.Prompt, "text" | "agents" | "skills">> & {
  files?: PromptFile[]
  pasted: PastedText[]
  mode?: "normal" | "shell"
  /** Session the entry was submitted in; undefined keeps it on the home composer. */
  sessionID?: string
}

export type PromptPartRef = {
  type: "file" | "agent" | "skill" | "pasted"
  index: number
}

export const emptyPrompt = (): PromptInfo => ({ text: "", files: [], agents: [], skills: [], pasted: [] })

// Part ranges are textarea offsets, so shift by the measured offset rather than string length.
export function appendPrompt(prompt: PromptInfo, following: PromptInfo, widthMethod: WidthMethod): PromptInfo {
  const text = prompt.text ? `${prompt.text}\n\n` : ""
  const offset = measureEditText(text, { widthMethod })
  const shift = <T extends { start: number; end: number }>(range: T, by: number) => ({
    ...range,
    start: range.start + by,
    end: range.end + by,
  })
  const mentions = <T extends { mention?: { start: number; end: number } }>(
    items: T[] | undefined,
    next: T[] | undefined,
  ) => [
    ...(items ?? []).map((item) => ({ ...item, mention: item.mention && shift(item.mention, 0) })),
    ...(next ?? []).map((item) => ({ ...item, mention: item.mention && shift(item.mention, offset) })),
  ]
  return {
    text: text + following.text,
    files: mentions(prompt.files, following.files),
    agents: mentions(prompt.agents, following.agents),
    skills: mentions(prompt.skills, following.skills),
    pasted: [
      ...prompt.pasted.map((part) => ({ ...part, source: shift(part.source, 0) })),
      ...following.pasted.map((part) => ({ ...part, source: shift(part.source, offset) })),
    ],
  }
}

export const MAX_HISTORY_ENTRIES = 50

// With per-session scoping the global cap would make sessions share history
// depth, so the cap applies per scope; TOTAL bounds the file itself.
const MAX_HISTORY_TOTAL = 1000

export function parsePromptHistory(text: string) {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return parsePromptInfo(JSON.parse(line))
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
  return trimPromptHistory(lines)
}

export function trimPromptHistory(entries: PromptInfo[]) {
  const seen = new Map<string | undefined, number>()
  const kept: PromptInfo[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const count = (seen.get(entry.sessionID) ?? 0) + 1
    if (count > MAX_HISTORY_ENTRIES) continue
    seen.set(entry.sessionID, count)
    kept.push(entry)
  }
  return kept.reverse().slice(-MAX_HISTORY_TOTAL)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export function parsePromptInfo(value: unknown): PromptInfo | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.text !== "string" || !Array.isArray(input.pasted)) return
  return input as PromptInfo
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0)
        writeText(historyPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    })

    const [store, setStore] = createStore({ history: [] as PromptInfo[] })

    // Navigation cursor is per scope: the newest scope is the one currently
    // being walked, so switching sessions never inherits another session's
    // position. scope === undefined is the home composer bucket.
    const cursor = new Map<string | undefined, number>()
    const scopeKey = (sessionID?: string) => sessionID
    const scoped = (sessionID?: string) =>
      store.history.filter((item) => scopeKey(item.sessionID) === scopeKey(sessionID))
    const currentCursor = (sessionID?: string) => cursor.get(scopeKey(sessionID)) ?? 0

    return {
      move(direction: 1 | -1, input: string, sessionID?: string) {
        const history = scoped(sessionID)
        if (!history.length) return undefined
        const index = currentCursor(sessionID)
        const current = history.at(index)
        if (!current) return undefined
        if (current.text !== input && input.length) return
        const next = index + direction
        if (Math.abs(next) > history.length || next > 0) return
        cursor.set(scopeKey(sessionID), next)
        if (next === 0) return emptyPrompt()
        return history.at(next)
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        const history = scoped(entry.sessionID)
        const key = scopeKey(entry.sessionID)
        if (isDuplicateEntry(history.at(-1), entry)) {
          cursor.set(key, 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            const kept = trimPromptHistory(draft.history)
            trimmed = kept.length !== draft.history.length
            draft.history = kept
          }),
        )
        cursor.set(key, 0)

        if (trimmed) {
          writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
          return
        }
        appendText(historyPath, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
