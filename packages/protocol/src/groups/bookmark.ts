import { MessageBookmark } from "@opencode/schema/message-bookmark"
import { MyMessage } from "@opencode/schema/my-message"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { SessionNotFoundError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without notice."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    // The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

const errors = [SessionNotFoundError] as const
const query = { sessionID: Session.ID }

/**
 * `bookmark.*` and `myMessage.*` in the `server.experimental` group (see `groups/experimental.ts`).
 * The endpoint-name prefix drives the generated client namespace, so both prefixes land under
 * `client.experimental`.
 */
export const BookmarkEndpoints = [
  HttpApiEndpoint.get("bookmark.list", "/api/experimental/bookmark", {
    query,
    success: Schema.Struct({ data: Schema.Array(MessageBookmark.Info) }),
    error: errors,
  }).annotateMerge(
    annotations(
      "bookmark.list",
      "List message bookmarks",
      "List a Session's message bookmarks, oldest first.",
    ),
  ),
  HttpApiEndpoint.post("bookmark.mark", "/api/experimental/bookmark", {
    payload: MessageBookmark.MarkPayload,
    success: Schema.Struct({ data: Schema.Struct({ bookmarked: Schema.Boolean }) }),
    error: errors,
  })
    .annotateMerge(
      annotations(
        "bookmark.mark",
        "Bookmark a message",
        "Adds a bookmark if the message is not bookmarked yet; idempotent.",
      ),
    ),
  HttpApiEndpoint.delete("bookmark.unmark", "/api/experimental/bookmark/:sessionID/:messageID", {
    params: { sessionID: Session.ID, messageID: SessionMessage.ID },
    success: Schema.Struct({ data: Schema.Struct({ removed: Schema.Boolean }) }),
    error: errors,
  }).annotateMerge(annotations("bookmark.unmark", "Remove a message bookmark", "Removes a message's bookmark.")),
  HttpApiEndpoint.get("myMessage.list", "/api/experimental/my-message", {
    query,
    success: Schema.Struct({ data: Schema.Array(MyMessage.Info) }),
    error: errors,
  }).annotateMerge(
    annotations(
      "myMessage.list",
      "List my messages",
      "List a Session's 'My messages' entries (what the user typed, plus question answers), oldest first.",
    ),
  ),
] as const

