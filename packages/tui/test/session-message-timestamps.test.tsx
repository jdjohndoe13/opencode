import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { Locale } from "../src/util/locale"

// The transcript shows a timestamp on each user message and on each assistant footer.
// The dates are built from local components so Locale.stamp's output is deterministic
// regardless of the machine's timezone.
test("session transcript stamps user messages and assistant footers", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const created = new Date(2026, 9, 23, 14, 30, 5).getTime()
  const completed = new Date(2026, 9, 23, 14, 31, 12).getTime()
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
      time: { created },
    },
    {
      id: "message-0000002",
      type: "assistant",
      agent: "build",
      model: { providerID: "demo", id: "demo-model" },
      content: [{ type: "text", text: "Assistant reply" }],
      finish: "stop",
      time: { created, completed },
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
    const userStamp = `[${Locale.stamp(created)}]`
    const assistantStamp = `[${Locale.stamp(completed)}]`
    await waitForHighlightedFrame(
      setup,
      (frame) =>
        frame.includes(userStamp) &&
        frame.includes("Hello timestamps") &&
        frame.includes(assistantStamp) &&
        frame.includes("Assistant reply"),
    )
    const frame = setup.captureCharFrame()
    expect(frame).toContain("2026-10-23 14:30:05")
    expect(frame).toContain("2026-10-23 14:31:12")
    expect(frame).toContain("Hello timestamps")
    expect(frame).toContain("Assistant reply")
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.finally(() => server.stop(true))
  }
})
