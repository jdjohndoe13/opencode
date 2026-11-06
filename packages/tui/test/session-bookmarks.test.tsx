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
    content: [
      // Turn 28's report carries the marker: the TUI must bookmark it
      // automatically and hide the marker line from the transcript.
      {
        type: "text" as const,
        text: turn === 28 ? "Bookmark answer 28\n⚑ BOOKMARK" : `Bookmark answer ${turn}`,
      },
      // Turn 25 asked a question and the user picked an option; the answer
      // lives in the tool's metadata, and the "My messages" block must show
      // it as one of the user's own entries. It sits among the newest ten
      // entries so the capped list renders it.
      ...(turn === 25
        ? [
            {
              type: "tool" as const,
              id: `call_${turn}`,
              name: "question",
              state: {
                status: "completed" as const,
                input: { questions: [{ question: "Which layout?" }] },
                content: [{ type: "text" as const, text: "User has answered your questions." }],
                metadata: { answers: [["Sidebar rail"]] },
              },
              time: { created: turn * 10 + 1, completed: turn * 10 + 2 },
            },
          ]
        : []),
    ],
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

// The sidebar header row of a block ("Bookmarks" or "My messages"), identified
// by its title plus the search glyph. The session title is also "Bookmarks",
// but it never carries the glass.
const headerAt = (frame: string, title: string) => {
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes(title) && line.includes("⌕"))
  return row === -1 ? undefined : { line: lines[row]!, row }
}

test("bookmarks star, sidebar list, and transcript jump", async () => {
  await using state = await tmpdir()
  await mkdir(`${state.path}/test/tui`, { recursive: true })
  const store = `${state.path}/test/tui/message-bookmarks.json`
  await Bun.write(store, JSON.stringify(seed))
  await using app = await createAppFixture({
    width: 140,
    height: 44,
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
    // The turn-28 report carried the `⚑ BOOKMARK` marker, so the TUI
    // bookmarked it automatically: the row appears in the sidebar and the
    // marker line itself is hidden from the transcript.
    await app.waitForFrame((next) => next.includes("★ Bookmark answer 28"))
    expect(app.captureCharFrame()).not.toContain("⚑ BOOKMARK")
    // The "My messages" block sits above the bookmarks and lists the user's
    // own messages and question answers newest-first, capped by a nested
    // scroll region. The "Sidebar rail" row is the answer the user picked
    // when the agent asked a question at turn 25.
    expect(frame).toContain("My messages ⌕ (31)")
    expect(frame).toContain("Sidebar rail")
    expect(headerAt(frame, "My messages")!.row).toBeLessThan(headerAt(frame, "Bookmarks")!.row)

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
    expect((await stored()).map((entry) => entry.messageID)).toEqual([id(0, 0), id(28, 1)])

    // The bookmarks header's magnifying glass opens a searchable bookmark
    // list. The glyph is a single cell, so the click must land exactly on it.
    const glass = headerAt(app.captureCharFrame(), "Bookmarks")!
    await app.mockMouse.click(glass.line.indexOf("⌕"), glass.row)
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

    // Each header's triangle collapses its own list to a single line that
    // keeps the glass and the count; clicking it again expands. The layout
    // may still settle after the dialog closes, so the glyph is re-located
    // and re-clicked on every frame pass until it takes effect.
    const clickTriangle = (title: string, direction: "collapse" | "expand") =>
      app.waitForFrame(async (next) => {
        const glyph = direction === "collapse" ? "▶" : "▼"
        const current = headerAt(next, title)
        if (current?.line.includes(glyph)) return true
        const opposite = direction === "collapse" ? "▼" : "▶"
        if (current?.line.includes(opposite))
          await app.mockMouse.click(current.line.indexOf(opposite), current.row)
        return false
      })
    const myMessages = () => app.captureCharFrame().split("\n").filter((line) => line.includes(" › ")).length
    // The block caps its list at 10 rows and scrolls the rest internally.
    expect(myMessages()).toBe(10)

    await clickTriangle("My messages", "collapse")
    const collapsed = app.captureCharFrame()
    expect(headerAt(collapsed, "My messages")!.line).toContain("(31)")
    expect(headerAt(collapsed, "My messages")!.line).toContain("⌕")
    expect(myMessages()).toBe(0)
    // The bookmarks block is untouched by the other block's collapse.
    expect(collapsed).toContain("★ First prompt zero")
    await clickTriangle("My messages", "expand")
    expect(myMessages()).toBe(10)

    await clickTriangle("Bookmarks", "collapse")
    const collapsedBookmarks = app.captureCharFrame()
    expect(headerAt(collapsedBookmarks, "Bookmarks")!.line).toContain("(2)")
    expect(collapsedBookmarks).not.toContain("★ First prompt zero")
    await clickTriangle("Bookmarks", "expand")
    expect(app.captureCharFrame()).toContain("★ First prompt zero")
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
  }
})
