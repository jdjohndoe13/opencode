export * as Bookmark from "./bookmark.js"

import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { Node, makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ascending } from "@opencode/schema/identifier"
import { MessageBookmark } from "@opencode/schema/message-bookmark"
import { MyMessage } from "@opencode/schema/my-message"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Database } from "./database/database.js"
import { DatabaseBatch } from "./database/batch.js"
import { SessionStore } from "./session/store.js"
import { NotFoundError } from "./session/error.js"
import type { SessionSchema } from "./session/schema.js"
import { MessageBookmarkTable, MyMessageTable, toBookmarkInfo, toMyMessageInfo } from "./bookmark/sql.js"

/** Kept at the top level of the client's data layer as `bookmark` and `myMessage`. */
export const BOOKMARK_LIMIT = 200

// When the user asks the agent to bookmark its report, the agent ends the
// message with a line containing only this marker (see the system prompt);
// the server watches for it at assistant completion and bookmarks the message.
// The TUI keeps its own copy of these helpers; the server must not import from it.
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

/** The bookmarked snapshot: the marker line removed, whitespace collapsed to single spaces. */
export function bookmarkText(text: string) {
  return stripBookmarkMarker(text).replace(/\s+/g, " ").trim()
}

/**
 * `metadata.answers` is one entry per question, each a list of the selected
 * option labels. A single question renders its answer alone; several
 * questions join their answers.
 */
export function answerText(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const answers = value
    .map((answer) => (Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : []))
    .map((answer) => answer.join(", "))
    .filter((answer) => answer.length > 0)
  if (answers.length === 0) return undefined
  return answers.join(" · ")
}

/**
 * Direct database helpers for the projector, which is the only write path. Both are
 * `onConflictDoNothing` upserts, so re-projection and the fork copy's re-derivation never
 * duplicate a row.
 */
export const insertBookmark = Effect.fn("Bookmark.insertBookmark")(function* (
  db: Database.Interface["db"],
  entry: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly text: string
    readonly created: number
  },
) {
  yield* db
    .insert(MessageBookmarkTable)
    .values({
      id: `bmk_${ascending()}`,
      session_id: entry.sessionID,
      message_id: entry.messageID,
      text: entry.text,
      created: entry.created,
      time_created: entry.created,
      time_updated: entry.created,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const insertMyMessage = Effect.fn("Bookmark.insertMyMessage")(function* (
  db: Database.Interface["db"],
  entry: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly ordinal: number
    readonly text: string
    readonly created: number
  },
) {
  yield* db
    .insert(MyMessageTable)
    .values({
      id: `mmsg_${ascending()}`,
      session_id: entry.sessionID,
      message_id: entry.messageID,
      ordinal: entry.ordinal,
      text: entry.text,
      created: entry.created,
      time_created: entry.created,
      time_updated: entry.created,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** Drops the bookmark and my-message rows that belonged to deleted messages (revert cleanup). */
export const removeForMessages = Effect.fn("Bookmark.removeForMessages")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  messageIDs: ReadonlyArray<SessionMessage.ID>,
) {
  if (messageIDs.length === 0) return
  yield* db
    .delete(MyMessageTable)
    .where(and(eq(MyMessageTable.session_id, sessionID), inArray(MyMessageTable.message_id, messageIDs)))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(MessageBookmarkTable)
    .where(and(eq(MessageBookmarkTable.session_id, sessionID), inArray(MessageBookmarkTable.message_id, messageIDs)))
    .run()
    .pipe(Effect.orDie)
})

/** Keeps the newest 200 bookmarks per Session; a direct db helper so the projector can trim too. */
export const trim = Effect.fn("Bookmark.trim")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  // The per-Session count stays near the cap because every insert trims, so this read is cheap.
  const rows = yield* db
    .select({ id: MessageBookmarkTable.id })
    .from(MessageBookmarkTable)
    .where(eq(MessageBookmarkTable.session_id, sessionID))
    .orderBy(desc(MessageBookmarkTable.created), desc(MessageBookmarkTable.id))
    .all()
    .pipe(Effect.orDie)
  for (const ids of DatabaseBatch.batches(rows.slice(BOOKMARK_LIMIT).map((row) => row.id), 1)) {
    yield* db.delete(MessageBookmarkTable).where(inArray(MessageBookmarkTable.id, ids)).run().pipe(Effect.orDie)
  }
})

export interface Interface {
  /** Bookmarks of a Session, oldest first. */
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<MessageBookmark.Info[], NotFoundError>
  /** Adds a bookmark if the message is not bookmarked yet; idempotent, and keeps the newest 200 per Session. */
  readonly mark: (
    input: MessageBookmark.MarkPayload,
  ) => Effect.Effect<{ readonly bookmarked: boolean }, NotFoundError>
  readonly unmark: (
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly removed: boolean }, NotFoundError>
  /** A Session's "My messages" entries, oldest first. */
  readonly listMyMessages: (sessionID: SessionSchema.ID) => Effect.Effect<MyMessage.Info[], NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Bookmark") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service

    // The Session must exist for its rows to survive (the FK cascades); reads and writes check it.
    const requireSession = (sessionID: SessionSchema.ID) =>
      store.get(sessionID).pipe(
        Effect.flatMap((session) => (session ? Effect.void : Effect.fail(new NotFoundError({ sessionID })))),
      )

    return Service.of({
      list: Effect.fn("Bookmark.list")(function* (sessionID) {
        yield* requireSession(sessionID)
        const rows = yield* db
          .select()
          .from(MessageBookmarkTable)
          .where(eq(MessageBookmarkTable.session_id, sessionID))
          .orderBy(asc(MessageBookmarkTable.created), asc(MessageBookmarkTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(toBookmarkInfo)
      }),
      mark: Effect.fn("Bookmark.mark")(function* (input) {
        yield* requireSession(input.sessionID)
        const existing = yield* db
          .select({ id: MessageBookmarkTable.id })
          .from(MessageBookmarkTable)
          .where(
            and(
              eq(MessageBookmarkTable.session_id, input.sessionID),
              eq(MessageBookmarkTable.message_id, input.messageID),
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (existing) return { bookmarked: false }
        const created = input.created ?? (yield* Clock.currentTimeMillis)
        yield* insertBookmark(db, { sessionID: input.sessionID, messageID: input.messageID, text: input.text, created })
        yield* trim(db, input.sessionID)
        return { bookmarked: true }
      }),
      unmark: Effect.fn("Bookmark.unmark")(function* (sessionID, messageID) {
        yield* requireSession(sessionID)
        const existing = yield* db
          .select({ id: MessageBookmarkTable.id })
          .from(MessageBookmarkTable)
          .where(and(eq(MessageBookmarkTable.session_id, sessionID), eq(MessageBookmarkTable.message_id, messageID)))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!existing) return { removed: false }
        yield* db
          .delete(MessageBookmarkTable)
          .where(and(eq(MessageBookmarkTable.session_id, sessionID), eq(MessageBookmarkTable.message_id, messageID)))
          .run()
          .pipe(Effect.orDie)
        return { removed: true }
      }),
      listMyMessages: Effect.fn("Bookmark.listMyMessages")(function* (sessionID) {
        yield* requireSession(sessionID)
        const rows = yield* db
          .select()
          .from(MyMessageTable)
          .where(eq(MyMessageTable.session_id, sessionID))
          .orderBy(asc(MyMessageTable.created), asc(MyMessageTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(toMyMessageInfo)
      }),
    })
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionStore.node],
})
