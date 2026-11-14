export * as MyMessage from "./my-message.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

/**
 * A "My messages" entry: what the user typed, or the answer they picked when the agent asked a
 * question. Answers are not their own user message; they live in the question tool's metadata, so
 * the server folds them into their own rows at projection time.
 */
export const Info = Schema.Struct({
  sessionID: SessionID,
  messageID: SessionMessage.ID,
  text: Schema.String,
  created: Schema.Finite.annotate({ description: "Time in milliseconds since the Unix epoch" }),
}).annotate({ identifier: "MyMessage.Info" })
export type Info = typeof Info.Type
