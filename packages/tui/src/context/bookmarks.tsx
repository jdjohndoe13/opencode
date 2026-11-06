import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useStorage } from "./storage"

export type BookmarkEntry = {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly created: number
}

// Set by the sidebar when a bookmark row is clicked; the session route
// consumes it and scrolls the transcript to that message.
type PendingJump = { readonly sessionID: string; readonly messageID: string; readonly token: number }

export const BOOKMARKS_LIMIT = 200

// When the user asks the agent to bookmark its report, the agent ends the
// message with a line containing only this marker (see the system prompt);
// the session route watches for it and bookmarks the message.
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

export function toggleBookmarks(entries: readonly BookmarkEntry[], entry: BookmarkEntry) {
  const exists = entries.some((item) => item.sessionID === entry.sessionID && item.messageID === entry.messageID)
  if (exists)
    return entries.filter((item) => !(item.sessionID === entry.sessionID && item.messageID === entry.messageID))
  return [...entries, entry].slice(-BOOKMARKS_LIMIT)
}

export function sessionBookmarks(entries: readonly BookmarkEntry[], sessionID: string) {
  return entries.filter((item) => item.sessionID === sessionID)
}

export const { use: useBookmarks, provider: BookmarksProvider } = createSimpleContext({
  name: "Bookmarks",
  init: () => {
    const [file, update] = useStorage().store<{ entries: BookmarkEntry[] }>("message-bookmarks", {
      initial: { entries: [] },
    })
    // `pending` is transport-only: never persisted, cleared on restart.
    const [runtime, setRuntime] = createStore({ pending: undefined as PendingJump | undefined })
    let token = 0
    return {
      entries: () => file.entries,
      isBookmarked: (sessionID: string, messageID: string) =>
        file.entries.some((item) => item.sessionID === sessionID && item.messageID === messageID),
      toggle: (entry: BookmarkEntry) => {
        void update((draft) => {
          draft.entries = toggleBookmarks(draft.entries, entry)
        }).catch((error) => console.error("Failed to persist message bookmarks", error))
      },
      // Add-if-missing, for the marker auto-bookmark: a re-run of the
      // watcher must never toggle an existing bookmark off.
      mark: (entry: BookmarkEntry) => {
        if (file.entries.some((item) => item.sessionID === entry.sessionID && item.messageID === entry.messageID))
          return
        void update((draft) => {
          draft.entries = [...draft.entries, entry].slice(-BOOKMARKS_LIMIT)
        }).catch((error) => console.error("Failed to persist message bookmarks", error))
      },
      // Drop entries whose message no longer exists (deleted session, revert).
      prune: (live: (sessionID: string, messageID: string) => boolean) => {
        if (!file.entries.some((item) => !live(item.sessionID, item.messageID))) return
        void update((draft) => {
          draft.entries = draft.entries.filter((item) => live(item.sessionID, item.messageID))
        }).catch((error) => console.error("Failed to prune message bookmarks", error))
      },
      request: (sessionID: string, messageID: string) => setRuntime("pending", { sessionID, messageID, token: ++token }),
      pending: () => runtime.pending,
      clearRequested: () => setRuntime("pending", undefined),
    }
  },
})
