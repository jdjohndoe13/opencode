// Measurement bench for long-session scaling (not part of the normal suite:
// run explicitly with `bun test test/perf-long-session.test.tsx --timeout 600000`).
// Reproduces the "day-long session becomes unresponsive" complaint by measuring
// per-delta and per-scroll cost at different session sizes.
import { expect, test } from "bun:test"
import { type Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const TURNS = Number(process.env.PERF_TURNS ?? 100)
const DELTAS = Number(process.env.PERF_DELTAS ?? 100)

function fixture(TURNS: number) {
  const sessionID = "ses_perf"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
  const messages: SessionMessageInfo[] = Array.from({ length: TURNS }, (_, turn) => [
    { type: "user" as const, id: id(turn, 0), text: `History prompt ${turn}`, time: { created: turn * 10 } },
    {
      type: "assistant" as const,
      id: id(turn, 1),
      agent: "build",
      model: { providerID: "demo", id: "model" },
      finish: "stop" as const,
      time: { created: turn * 10 + 1, completed: turn * 10 + 2 },
      content: [
        { type: "text" as const, text: `History answer ${turn}\n\nSome longer text to make the rows heavier.` },
      ],
    },
  ]).flat()
  return { sessionID, location, messages, id }
}

test("measure per-delta and per-scroll cost at session size", async () => {
  const { sessionID, location, messages, id } = fixture(TURNS)
  await using app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Perf fixture",
            agent: "build",
            model: { providerID: "demo", id: "model" },
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      return undefined
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes(`History answer ${TURNS - 1}`) && frame.includes("Demo Model"))
  const find = (root: Renderable): ScrollBoxRenderable | undefined =>
    root instanceof ScrollBoxRenderable && root.getRenderable(id(TURNS - 1, 1))
      ? root
      : root.getChildren().map(find).find(Boolean)
  const scroll = find(app.renderer.root)
  if (!scroll) throw new Error("Session scrollbox not found")
  await app.waitForVisualIdle({ quietFrames: 3 })

  // Streaming deltas into the newest assistant message: the live cost while an
  // agent is generating, at the bottom of the transcript.
  const t0 = performance.now()
  for (let i = 0; i < DELTAS; i++) {
    app.events.emit({
      id: `evt_perf_${i}`,
      created: 1000 + i,
      type: "session.text.delta",
      data: {
        sessionID,
        assistantMessageID: id(TURNS - 1, 1),
        ordinal: 0,
        delta: ` chunk ${i}`,
      },
    })
  }
  await app.waitForVisualIdle({ quietFrames: 3 })
  const t1 = performance.now()
  console.log(`PERF turns=${TURNS} deltas=${DELTAS} perDelta=${((t1 - t0) / DELTAS).toFixed(2)}ms`)

  // The interactive case: one delta per frame, the way a live agent streams.
  if (process.env.PERF_INTERACTIVE) {
    const t4 = performance.now()
    for (let i = 0; i < DELTAS; i++) {
      app.events.emit({
        id: `evt_perf_live_${i}`,
        created: 2000 + i,
        type: "session.text.delta",
        data: {
          sessionID,
          assistantMessageID: id(TURNS - 1, 1),
          ordinal: 0,
          delta: ` live ${i}`,
        },
      })
      await app.renderOnce()
    }
    const t5 = performance.now()
    console.log(`PERF turns=${TURNS} interactive deltas=${DELTAS} perDelta=${((t5 - t4) / DELTAS).toFixed(2)}ms`)
  }

  // Scrolling: the user's "can't scroll" complaint.
  const t2 = performance.now()
  for (let i = 0; i < 10; i++) await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
  await app.waitForVisualIdle({ quietFrames: 3 })
  const t3 = performance.now()
  console.log(`PERF turns=${TURNS} scroll10=${((t3 - t2) / 10).toFixed(2)}ms/scroll`)

  // The day-long scenario: scroll up through the session (the mount window
  // only grows), then stream into the newest message while parked away from
  // the bottom. This is the reported "unresponsive" state.
  if (process.env.PERF_SCROLLUP) {
    for (let tick = 0; tick < Number(process.env.PERF_SCROLLUP); tick++) {
      await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
      await app.renderOnce()
    }
    await app.waitForVisualIdle({ quietFrames: 3 })
    const t4 = performance.now()
    for (let i = 0; i < DELTAS; i++) {
      app.events.emit({
        id: `evt_perf_parked_${i}`,
        created: 5000 + i,
        type: "session.text.delta",
        data: {
          sessionID,
          assistantMessageID: id(TURNS - 1, 1),
          ordinal: 0,
          delta: ` parked ${i}`,
        },
      })
    }
    await app.waitForVisualIdle({ quietFrames: 3 })
    const t5 = performance.now()
    console.log(`PERF turns=${TURNS} parked=true deltas=${DELTAS} perDelta=${((t5 - t4) / DELTAS).toFixed(2)}ms`)
  }

  expect(t1 - t0).toBeLessThan(60000)
})
