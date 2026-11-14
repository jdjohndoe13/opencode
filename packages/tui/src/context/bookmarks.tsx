import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useStorage } from "./storage"
import { useClient } from "./client"
import { useData } from "./data"

export type BookmarkEntry = {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly created: number
}

// Set by the sidebar when a bookmark row is clicked; the session route
// consumes it and scrolls the transcript to that message.
type PendingJump = { readonly sessionID: string; readonly messageID: string; readonly token: number }

// When the user asks the agent to bookmark its report, the agent ends the
// message with a line containing only this marker (see the system prompt);
// the server scans the finished message for it and stores the bookmark. The
// transcript still hides the marker line from display, so the TUI keeps its
// own copy of these helpers; the server does NOT strip it from stored text.
export const BOOKMARK_MARKER = "⚑ BOOKMARK"

export function hasBookmarkMarker(text: string) {
  return text.split(/\r?\n/).some((line) => line.trim() === BOOKMARK_MARKER)
}

export function stripBookmarkMarker(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== BOOKMARK_MARKER)
    .join("\n")
}

export const { use: useBookmarks, provider: BookmarksProvider } = createSimpleContext({
  name: "Bookmarks",
  init: () => {
    const client = useClient()
    const data = useData()
    // The legacy JSON store is no longer the source of truth; it only feeds
    // the one-time import below. After the import clears it, the empty list
    // is the guard against re-importing.
    const [legacy, updateLegacy] = useStorage().store<{ entries: BookmarkEntry[] }>("message-bookmarks", {
      initial: { entries: [] },
    })
    // `pending` is transport-only: never persisted, cleared on restart.
    const [runtime, setRuntime] = createStore({ pending: undefined as PendingJump | undefined })
    let token = 0

    if (legacy.entries.length > 0) {
      const entries = legacy.entries.slice()
      void (async () => {
        for (const entry of entries) {
          await client.api.experimental.bookmark
            .mark({
              sessionID: entry.sessionID,
              messageID: entry.messageID,
              text: entry.text,
              created: entry.created,
            })
            .catch((error) => console.error("Failed to import message bookmark", error))
        }
        await updateLegacy((draft) => {
          draft.entries = []
        })
      })().catch((error) => console.error("Failed to import message bookmarks", error))
    }

    return {
      // A session's bookmarks, oldest first (the server's order); consumers
      // that show newest-first reverse the list themselves.
      list: (sessionID: string) => data.bookmark.list(sessionID),
      isBookmarked: (sessionID: string, messageID: string) =>
        data.bookmark.list(sessionID).some((item) => item.messageID === messageID),
      toggle: (entry: BookmarkEntry) => {
        const marked = data.bookmark.list(entry.sessionID).some((item) => item.messageID === entry.messageID)
        const request = marked
          ? client.api.experimental.bookmark.unmark({ sessionID: entry.sessionID, messageID: entry.messageID })
          : client.api.experimental.bookmark.mark({
              sessionID: entry.sessionID,
              messageID: entry.messageID,
              text: entry.text,
              created: entry.created,
            })
        void request
          .then(() => {
            // The server is the source of truth and `mark` is idempotent, so
            // this optimistic refresh racing the event-driven refresh is
            // harmless.
            data.bookmark.invalidate(entry.sessionID)
            return data.bookmark.sync(entry.sessionID)
          })
          .catch((error) => console.error("Failed to update message bookmark", error))
      },
      // A session's "My messages" entries, oldest first; the server projects
      // user messages and question answers into them.
      myMessages: (sessionID: string) => data.myMessage.list(sessionID),
      // Pulls both server-derived lists; the session route triggers the
      // initial load and live updates piggyback on the message events.
      sync: (sessionID: string) =>
        Promise.all([data.bookmark.sync(sessionID), data.myMessage.sync(sessionID)]).then(() => undefined),
      request: (sessionID: string, messageID: string) => setRuntime("pending", { sessionID, messageID, token: ++token }),
      pending: () => runtime.pending,
      clearRequested: () => setRuntime("pending", undefined),
    }
  },
})
