import { expect, test } from "bun:test"
import { type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("the top-right jump-to-start indicator appears when content is above and jumps on click", async () => {
  const sessionID = "ses_jump_start"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `message-${index}`,
    type: "user",
    text: `History message ${String(index).padStart(4, "0")}`,
    time: { created: index },
  }))
  await using app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Jump start fixture",
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
  await app.waitForFrame((frame) => frame.includes("History message 0039") && frame.includes("Demo Model"))
  const find = (root: Renderable): ScrollBoxRenderable | undefined =>
    root instanceof ScrollBoxRenderable && root.getRenderable("message-39")
      ? root
      : root.getChildren().map(find).find(Boolean)
  const scroll = find(app.renderer.root)
  if (!scroll) throw new Error("Session scrollbox not found")

  // At the bottom the reader follows the tail: neither indicator is offered.
  expect(app.captureCharFrame()).not.toContain("Jump to latest")
  expect(app.captureCharFrame()).not.toContain("Jump to start")

  for (let tick = 0; tick < 3; tick++) await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
  await app.waitForFrame((frame) => frame.includes("Jump to latest") && frame.includes("Jump to start"))
  expect(scroll.scrollTop).toBeGreaterThan(0)

  const frame = app.captureCharFrame().split("\n")
  const row = frame.findIndex((line) => line.includes("Jump to start"))
  if (row === -1) throw new Error("Jump to start indicator missing from frame")
  await app.mockMouse.click(frame[row]!.indexOf("Jump to start") + 1, row)

  await app.waitForFrame(() => scroll.scrollTop === 0)
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(app.captureCharFrame()).not.toContain("Jump to start")
  expect(app.captureCharFrame()).toContain("Jump to latest")
  expect(app.captureCharFrame()).toContain("History message 0000")
})
