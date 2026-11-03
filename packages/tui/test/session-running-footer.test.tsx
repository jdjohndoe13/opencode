import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"

// The prompt footer keeps the working directory visible while the session is
// running, to the right of the "esc interrupt" hint, so several terminals
// open side by side can be told apart by their folder.
test("running footer keeps the working directory beside the interrupt hint", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 40, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_test",
    title: "Running footer",
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
      text: "Start working",
      time: { created: 1000 },
    },
  ]
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_test") return json({ data: session })
    if (url.pathname === "/api/session/ses_test/message") return json({ data: messages, cursor: {} })
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
    // Idle first: the directory alone shows below the prompt.
    await waitForHighlightedFrame(setup, (frame) => frame.includes(directory))
    // A running turn replaces the idle row with the interrupt hint; the folder
    // must stay visible on the same line to its right.
    events.emit({
      id: "evt_run",
      created: 2000,
      type: "session.execution.started",
      durable: { aggregateID: "ses_test", seq: 1, version: 1 },
      data: { sessionID: "ses_test" },
    })
    await waitForHighlightedFrame(
      setup,
      (frame) => frame.includes("esc interrupt") && frame.includes(directory),
    )
    const frame = setup.captureCharFrame()
    const line = frame
      .split("\n")
      .find((row) => row.includes("esc interrupt") && row.includes(directory))!
    expect(line.indexOf("esc interrupt")).toBeLessThan(line.indexOf(directory))
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.finally(() => server.stop(true))
  }
})
