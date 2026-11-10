import type { SessionMessageInfo } from "@opencode/client"

// A "My messages" entry: what the user typed, or the answer they picked when
// the agent asked a question. Answers are not their own user message; they
// live in the question tool's metadata, so they are folded in here.
export type MyMessage = { readonly id: string; readonly text: string; readonly created: number }

// `metadata.answers` is one entry per question, each a list of the selected
// option labels. A single question renders its answer alone; several
// questions join their answers.
function answerText(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const answers = value
    .map((answer) => (Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : []))
    .map((answer) => answer.join(", "))
    .filter((answer) => answer.length > 0)
  if (answers.length === 0) return undefined
  return answers.join(" · ")
}

function collect(message: SessionMessageInfo): MyMessage[] {
  if (message.type === "user") return [{ id: message.id, text: message.text, created: message.time.created }]
  if (message.type !== "assistant") return []
  const result: MyMessage[] = []
  for (const part of message.content) {
    if (part.type !== "tool" || part.name !== "question" || part.state.status !== "completed") continue
    const text = answerText(part.state.metadata?.answers)
    if (!text) continue
    result.push({ id: message.id, text, created: part.time.completed ?? part.time.created })
  }
  return result
}

export function myMessages(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): MyMessage[] {
  const result: MyMessage[] = []
  for (const message of messages) {
    if (boundary && message.id >= boundary) continue
    for (const item of collect(message)) result.push(item)
  }
  return result
}

/**
 * A `myMessages` bound to a memo. Streaming re-runs the memo on every
 * transcript change, so the per-message entries are cached: an unchanged
 * message reuses its previous objects, which keeps the row identities stable
 * for the list's `<For>` and skips re-reading every message's content.
 */
export function createMyMessages() {
  const cache = new Map<string, { message: SessionMessageInfo; version: number; items: MyMessage[] }>()
  return (messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): MyMessage[] => {
    const result: MyMessage[] = []
    const next = new Map<string, { message: SessionMessageInfo; version: number; items: MyMessage[] }>()
    for (const message of messages) {
      if (boundary && message.id >= boundary) continue
      const previous = cache.get(message.id)
      // The store mutates messages in place, so object identity alone misses
      // the question tool's answers landing after the message first appeared.
      // The version reads the question tools' completion state, which is the
      // only part of an assistant message the entries depend on.
      const version = messageVersion(message)
      const entry =
        previous && previous.message === message && previous.version === version
          ? previous
          : { message, version, items: collect(message) }
      next.set(message.id, entry)
      for (const item of entry.items) result.push(item)
    }
    cache.clear()
    for (const [id, entry] of next) cache.set(id, entry)
    return result
  }
}

function messageVersion(message: SessionMessageInfo) {
  if (message.type !== "assistant") return "text" in message ? message.text.length : 0
  let version = message.content.length
  for (const part of message.content) {
    if (part.type === "tool" && part.name === "question" && part.state.status === "completed")
      version += 1 + (part.time.completed ?? 0)
  }
  return version
}
