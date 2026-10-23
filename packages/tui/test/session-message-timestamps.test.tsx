import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { Locale } from "../src/util/locale"

// The transcript stamps every user message, opens each assistant reply with a
// timestamp at the top, and labels each tool call with its start time plus a
// live "running for" counter that becomes "ran for" once the call completes.
// Dates are built from local components so Locale.stamp's output is
// deterministic regardless of the machine's timezone.
test("session transcript stamps user messages, reply tops, and tool calls", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 40, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const userAt = new Date(2026, 9, 23, 14, 30, 5).getTime()
  const replyAt = new Date(2026, 9, 23, 14, 30, 30).getTime()
  const doneAt = new Date(2026, 9, 23, 14, 31, 12).getTime()
  const toolAt = new Date(2026, 9, 23, 14, 30, 40).getTime()
  const runningAt = new Date(2026, 9, 23, 14, 30, 50).getTime()
  const session = {
    id: "ses_test",
    title: "Timestamps",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = [
    {
      id: "message-0000001",
      type: "user",
      text: "Hello timestamps",
      time: { created: userAt },
    },
    {
      id: "message-0000002",
      type: "assistant",
      agent: "build",
      model: { providerID: "demo", id: "demo-model" },
      content: [
        {
          type: "tool",
          id: "call-shell",
          name: "shell",
          time: { created: toolAt, ran: toolAt, completed: toolAt + 90_000 },
          state: {
            status: "completed",
            input: { command: "echo hi" },
            content: [{ type: "text", text: "hi" }],
            metadata: {},
          },
        },
        {
          type: "tool",
          id: "call-running",
          name: "shell",
          time: { created: runningAt, ran: runningAt },
          state: { status: "running", input: { command: "sleep 999" }, metadata: {} },
        },
        { type: "text", text: "Assistant reply" },
      ],
      finish: "stop",
      time: { created: replyAt, completed: doneAt },
    },
  ]
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_test") return json({ data: session })
    if (url.pathname === "/api/session/ses_test/message") return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/ses_test/permission") return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })

  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" }, keybinds: {} }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID: "ses_test" },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    const userStamp = `[${Locale.stamp(userAt)}]`
    const headerStamp = `[${Locale.stamp(replyAt)}]`
    const toolStamp = `[${Locale.stamp(toolAt)}]`
    const runningStamp = `[${Locale.stamp(runningAt)}]`
    const footerStamp = `[${Locale.stamp(doneAt)}]`
    await waitForHighlightedFrame(
      setup,
      (frame) =>
        frame.includes(userStamp) &&
        frame.includes("Hello timestamps") &&
        frame.includes(headerStamp) &&
        frame.includes(toolStamp) &&
        frame.includes("ran for 01 minutes 30 seconds") &&
        frame.includes(runningStamp) &&
        frame.includes("running for") &&
        frame.includes(footerStamp) &&
        frame.includes("Assistant reply"),
    )
    const frame = setup.captureCharFrame()
    const at = (needle: string) => frame.indexOf(needle)
    // The reply stamp opens the reply above its content, and the footer stamp
    // (kept as the allowed duplicate) stays below it.
    expect(at(headerStamp)).toBeLessThan(at("Assistant reply"))
    expect(at(footerStamp)).toBeGreaterThan(at("Assistant reply"))
    // Each tool call carries its own start stamp; finished calls show how long
    // they ran, unfinished ones tick a live counter.
    expect(at(toolStamp)).toBeLessThan(at("ran for 01 minutes 30 seconds"))
    expect(at(runningStamp)).toBeLessThan(at("running for"))
    expect(frame).toContain("2026-10-23 14:30:05")
    expect(frame).toContain("2026-10-23 14:30:30")
    expect(frame).toContain("2026-10-23 14:31:12")
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.finally(() => server.stop(true))
  }
})
