import { Bookmark } from "@opencode/core/bookmark"
import type { MessageBookmark } from "@opencode/schema/message-bookmark"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { missingSession } from "./session-error"

/** `bookmark.*` and `myMessage.*` in the `server.experimental` group. */
export const makeBookmark = Effect.gen(function* () {
  const bookmarks = yield* Bookmark.Service

  const notFound = (error: Session.NotFoundError) => missingSession(error)

  return {
    list: (sessionID: Session.ID) =>
      bookmarks.list(sessionID).pipe(
        Effect.mapError(notFound),
        Effect.map((data) => ({ data })),
      ),
    mark: (payload: MessageBookmark.MarkPayload) =>
      bookmarks.mark(payload).pipe(
        Effect.mapError(notFound),
        Effect.map((data) => ({ data })),
      ),
    unmark: (sessionID: Session.ID, messageID: SessionMessage.ID) =>
      bookmarks.unmark(sessionID, messageID).pipe(
        Effect.mapError(notFound),
        Effect.map((data) => ({ data })),
      ),
    listMyMessages: (sessionID: Session.ID) =>
      bookmarks.listMyMessages(sessionID).pipe(
        Effect.mapError(notFound),
        Effect.map((data) => ({ data })),
      ),
  }
})
