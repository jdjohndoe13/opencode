import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

// The fork glyph beside a message's timestamp forks the session at that row's
// boundary: a prompt's header forks before the prompt (its text lands in the
// new session's composer), and a reply's footer forks through the reply, so
// the new session keeps the conversation up to and including that reply. The
// newest reply's footer takes the whole session.
const session = {
  id: "ses_fork",
  title: "Forking",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const forked = { ...session, id: "ses_forked", title: "Forked" }
const user = (id: string, text: string, created: number) => ({ type: "user" as const, id, text, time: { created } })
const assistant = (id: string, text: string, created: number) => ({
  type: "assistant" as const,
  id,
  agent: "build",
  model: { providerID: "fixture", id: "fixture" },
  finish: "stop" as const,
  time: { created, completed: created + 1 },
  content: [{ type: "text" as const, text }],
})
// Two turns; the transcript API returns newest-first.
const turn = [
  user("msg_first_prompt", "First ask", 1),
  assistant("msg_first_answer", "The first answer", 2),
  user("msg_second_prompt", "Second ask", 3),
  assistant("msg_second_answer", "The second answer", 4),
]
const messages = turn.toReversed()

const FORK = `POST /api/session/${session.id}/fork`

/**
 * Opens the session against a fake server that answers the fork request. `calls`
 * logs each fork as `POST .../fork <boundary>`, so a test can read the
 * boundary the icon asked the server for.
 */
async function openSession(forkedMessages: unknown[]) {
  const calls: string[] = []
  const app = await createAppFixture({
    width: 120,
    height: 30,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session, forked], cursor: {} })
      const [, id, rest] = /^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname) ?? []
      const known = [session, forked].find((item) => item.id === id)
      if (rest === "/message")
        return json({ data: id === session.id ? messages : id === forked.id ? forkedMessages : [], cursor: {} })
      if (rest === "/inbox" || rest === "/permission") return json({ data: [] })
      if (known && rest === "") return json({ data: known })
      if (url.pathname === FORK.slice("POST ".length)) {
        const before = (await request.json())?.before
        calls.push(`${request.method} ${url.pathname} ${before}`)
        return json({ data: forked })
      }
      return undefined
    },
  })
  await app.ready
  return Object.assign(app, { calls })
}

type App = Awaited<ReturnType<typeof openSession>>

// The footer glyph sits below the reply's text, on the row that also carries
// the copy glyph; the prompt header's glyph sits above the prompt's text with
// no copy glyph. The footers of fixture replies are identical strings, so the
// search runs by row index from the reply's text, not by line identity.
const clickFooter = async (app: App, glyph: string, replyText: string) => {
  await app.waitForFrame(() => true)
  const lines = app.captureCharFrame().split("\n")
  const at = lines.findIndex((line) => line.includes(replyText))
  expect(at).not.toBe(-1)
  const row = lines.findIndex((line, i) => i >= at && line.includes(glyph) && line.includes("⧉"))
  expect(row).not.toBe(-1)
  await app.mockMouse.click(lines[row].indexOf(glyph), row)
}

const clickHeader = async (app: App, glyph: string, promptText: string) => {
  await app.waitForFrame(() => true)
  const lines = app.captureCharFrame().split("\n")
  const at = lines.findIndex((line) => line.includes(promptText))
  expect(at).not.toBe(-1)
  const before = lines.slice(0, at).map((line, i) => ({ line, i })).toReversed()
  const after = lines.slice(at).map((line, i) => ({ line, i: i + at }))
  const hit = [...before, ...after].find(({ line }) => line.includes(glyph) && !line.includes("⧉"))
  expect(hit).toBeDefined()
  await app.mockMouse.click(hit!.line.indexOf(glyph), hit!.i)
}

test("the footer glyph on the newest reply forks the whole session", async () => {
  await using app = await openSession(messages)
  await waitForHighlightedFrame(app, (frame) => frame.includes("The second answer"))

  await clickFooter(app, "⎇", "The second answer")
  await app.waitForFrame((frame) => frame.includes("Forked session"))

  // No boundary: the fork takes the complete session.
  expect(app.calls).toEqual([`${FORK} undefined`])
  await app.waitForFrame((frame) => frame.includes("The second answer") && frame.includes("Forked"))
})

test("the footer glyph on an older reply forks through that reply", async () => {
  // The fork keeps the first turn only: the boundary is the next prompt.
  await using app = await openSession(turn.slice(0, 2).toReversed())
  await waitForHighlightedFrame(app, (frame) => frame.includes("The second answer"))

  await clickFooter(app, "⎇", "The first answer")
  await app.waitForFrame((frame) => frame.includes("Forked session"))

  expect(app.calls).toEqual([`${FORK} msg_second_prompt`])
  // The forked transcript holds the first turn; the forked-from prompt stays
  // in the history rather than landing in the composer (it was not the
  // boundary's own message).
  await app.waitForFrame((frame) => frame.includes("The first answer") && frame.includes("Forked"))
})

test("the fork glyph on a prompt forks before it and restores the prompt in the composer", async () => {
  // Nothing predates the first prompt, so the fork's transcript is empty.
  await using app = await openSession([])
  await waitForHighlightedFrame(app, (frame) => frame.includes("First ask"))

  // The glyph sits inside the prompt row, whose own click opens the message
  // dialog; the icon claims the click instead.
  await clickHeader(app, "⎇", "First ask")
  await app.waitForFrame((frame) => frame.includes("Forked session"))

  expect(app.calls).toEqual([`${FORK} msg_first_prompt`])
  // The prompt text is restored into the composer, not replayed.
  const frame = await app.waitForFrame((frame) => frame.split("First ask").length - 1 === 1)
  expect(frame).not.toContain("Message Actions")
})
