export * as MessageBookmark from "./message-bookmark.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

/**
 * A bookmark on one message of a Session, stored server-side. `text` is the bookmarked snapshot:
 * the user's text, or the assistant's text with any `⚑ BOOKMARK` marker line removed.
 */
export const Info = Schema.Struct({
  sessionID: SessionID,
  messageID: SessionMessage.ID,
  text: Schema.String,
  created: Schema.Finite.annotate({ description: "Time in milliseconds since the Unix epoch" }),
}).annotate({ identifier: "MessageBookmark.Info" })
export type Info = typeof Info.Type

/** The `mark` payload: the caller supplies the snapshot text, and `created` defaults to now. */
export const MarkPayload = Schema.Struct({
  sessionID: SessionID,
  messageID: SessionMessage.ID,
  text: Schema.String,
  created: optional(Schema.Finite),
}).annotate({ identifier: "MessageBookmark.MarkPayload" })
export type MarkPayload = typeof MarkPayload.Type
