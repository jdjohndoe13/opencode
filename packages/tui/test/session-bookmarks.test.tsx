import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

// Message bookmarks: the star beside a message's timestamp persists it, the
// sidebar lists the session's bookmarks newest-first, and clicking a row or
// cycling with the leader keys scrolls the transcript to that message.
const session = {
  id: "ses_bookmarks",
  title: "Bookmarks",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
const messages = Array.from({ length: 30 }, (_, turn) => [
  { type: "user" as const, id: id(turn, 0), text: `Bookmark prompt ${turn}`, time: { created: turn * 10 } },
  {
    type: "assistant" as const,
    id: id(turn, 1),
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop" as const,
    time: { created: turn * 10 + 1, completed: turn * 10 + 2 },
    content: [{ type: "text" as const, text: `Bookmark answer ${turn}` }],
  },
])
  .flat()
  .reverse()

// The stored text is what the sidebar shows; the transcript keeps showing
// the message's own text, so the two never collide in a frame assertion.
const seed = {
  entries: [
    { sessionID: session.id, messageID: id(0, 0), text: "First prompt zero", created: 0 },
    { sessionID: session.id, messageID: id(29, 1), text: "Second answer nine", created: 1 },
  ],
}

const locate = (frame: string, needle: string) => {
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes(needle))
  return row === -1 ? undefined : { x: lines[row]!.indexOf(needle) + 2, y: row }
}

// The transcript occupies the left columns of the frame; the sidebar renders
// on the same lines, so message visibility compares the transcript columns
// only, after stripping the user-message border glyph.
const shown = (frame: string, text: string) =>
  frame
    .split("\n")
    .some((line) => line.slice(0, 90).replace("┃", "").trim() === text)

test("bookmarks star, sidebar list, and transcript jump", async () => {
  await using state = await tmpdir()
  await mkdir(`${state.path}/test/tui`, { recursive: true })
  const store = `${state.path}/test/tui/message-bookmarks.json`
  await Bun.write(store, JSON.stringify(seed))
  await using app = await createAppFixture({
    width: 140,
    height: 30,
    state: state.path,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    },
  })
  const stored = async () => ((await Bun.file(store).json()) as typeof seed).entries

  try {
    await app.ready
    await waitForHighlightedFrame(app, (frame) => shown(frame, "Bookmark prompt 29"))

    // The transcript starts at the newest turn; the oldest turn is virtualized away.
    expect(shown(app.captureCharFrame(), "Bookmark prompt 0")).toBe(false)
    // The sidebar lists the session's stored bookmarks, newest first.
    const frame = app.captureCharFrame()
    expect(frame).toContain("★ Second answer nine")
    expect(frame).toContain("★ First prompt zero")

    // The previous bookmark is the oldest one: the transcript scrolls up to it.
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("k")
    await app.waitForFrame((next) => shown(next, "Bookmark prompt 0"))

    // Clicking the sidebar row for the newest bookmark scrolls back down.
    // The bookmark is the newest reply, so its own text is the visible top.
    const row = locate(app.captureCharFrame(), "Second answer nine")
    expect(row).toBeDefined()
    await app.mockMouse.click(row!.x, row!.y)
    await app.waitForFrame((next) => shown(next, "Bookmark answer 29"))

    // The leader toggle bookmarks the topmost message; whichever it is, the
    // store changes, and a second press restores the previous state.
    const before = (await stored()).length
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("f")
    await app.waitForFrame(async () => (await stored()).length !== before)
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("f")
    await app.waitForFrame(async () => (await stored()).length === before)

    // The footer star of the newest reply is filled (pre-seeded); clicking
    // it unbookmarks and that sidebar entry disappears. The reply's footer
    // is the last copy-glyph row in the transcript.
    const footers = app.captureCharFrame().split("\n").filter((line) => line.includes("⧉"))
    const footer = footers[footers.length - 1]
    expect(footer).toContain("★")
    const starRow = app.captureCharFrame().split("\n").lastIndexOf(footer)
    await app.mockMouse.click(footer.indexOf("★") + 1, starRow)
    await app.waitForFrame((next) => !next.includes("Second answer nine") && next.includes("First prompt zero"))
    expect((await stored()).map((entry) => entry.messageID)).toEqual([id(0, 0)])

    // The sidebar header's magnifying glass opens a searchable bookmark list.
    // The glyph is a single cell, so the click must land exactly on it.
    const lines = app.captureCharFrame().split("\n")
    const glassRow = lines.findIndex((line) => line.includes("⌕"))
    expect(glassRow).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[glassRow]!.indexOf("⌕"), glassRow)
    await app.waitForFrame((next) => next.includes("Search bookmarks"))

    // A query matching nothing reports it; narrowing to the first bookmark
    // and pressing Enter closes the dialog and scrolls the transcript to it.
    await app.mockInput.typeText("zzzz")
    await app.waitForFrame((next) => next.includes("No results found"))
    for (let i = 0; i < 4; i++) app.mockInput.pressBackspace()
    await app.mockInput.typeText("First")
    app.mockInput.pressEnter()
    await app.waitForFrame(
      (next) => !next.includes("Search bookmarks") && next.includes("First prompt zero") && shown(next, "Bookmark prompt 0"),
    )

    // The header's triangle collapses the list to a single line that keeps
    // the glass and the count; clicking the triangle again expands it. The
    // layout may still settle after the dialog closes, so the glyph is
    // re-located and re-clicked on every frame pass until it takes effect.
    const clickTriangle = (direction: string) =>
      app.waitForFrame(async (next) => {
        if (next.includes(direction === "collapse" ? "▶" : "▼")) return true
        const row = next.split("\n").findIndex((line) => line.includes(direction === "collapse" ? "▼" : "▶"))
        if (row >= 0) await app.mockMouse.click(next.split("\n")[row]!.indexOf(direction === "collapse" ? "▼" : "▶"), row)
        return false
      })
    await clickTriangle("collapse")
    const collapsed = app.captureCharFrame()
    expect(collapsed).toContain("⌕")
    expect(collapsed).toContain("(1)")
    expect(collapsed).not.toContain("★ First prompt zero")
    await clickTriangle("expand")
    expect(app.captureCharFrame()).toContain("★ First prompt zero")
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
  }
})
