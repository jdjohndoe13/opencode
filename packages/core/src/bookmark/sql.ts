import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { MessageBookmark } from "@opencode/schema/message-bookmark"
import type { MyMessage } from "@opencode/schema/my-message"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Timestamps } from "../database/schema.sql.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"

export const MessageBookmarkTable = sqliteTable(
  "message_bookmark",
  {
    id: text().$type<string>().primaryKey(),
    /** The Session whose message is bookmarked. */
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text()
      .$type<SessionMessage.ID>()
      .notNull(),
    text: text().notNull(),
    created: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("message_bookmark_session_message_idx").on(table.session_id, table.message_id),
    index("message_bookmark_session_idx").on(table.session_id),
  ],
)

export const MyMessageTable = sqliteTable(
  "my_message",
  {
    id: text().$type<string>().primaryKey(),
    /** The Session the entry belongs to. */
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text()
      .$type<SessionMessage.ID>()
      .notNull(),
    /** Position within the message: 0 for a user message, the part's ordinal for a question answer. */
    ordinal: integer().notNull(),
    text: text().notNull(),
    created: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("my_message_session_message_ordinal_idx").on(table.session_id, table.message_id, table.ordinal),
    index("my_message_session_idx").on(table.session_id),
  ],
)

export type MessageBookmarkRow = typeof MessageBookmarkTable.$inferSelect
export type MyMessageRow = typeof MyMessageTable.$inferSelect

export const toBookmarkInfo = (row: MessageBookmarkRow): MessageBookmark.Info => ({
  sessionID: row.session_id,
  messageID: row.message_id,
  text: row.text,
  created: row.created,
})

export const toMyMessageInfo = (row: MyMessageRow): MyMessage.Info => ({
  sessionID: row.session_id,
  messageID: row.message_id,
  text: row.text,
  created: row.created,
})
