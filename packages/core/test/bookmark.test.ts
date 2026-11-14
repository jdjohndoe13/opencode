import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Bookmark } from "@opencode/core/bookmark"
import { MessageBookmarkTable } from "@opencode/core/bookmark/sql"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionStore } from "@opencode/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Money } from "@opencode/schema/money"
import { makeDurableObjectStorage } from "./fixture/durable-object-storage"
import { testEffect } from "./lib/effect"

// Durable Object SQLite, which rejects statements that bind more than 100 parameters: the
// bookmark trim path deletes overflow in batches because of this.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      Session.node,
      Bookmark.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Database.node.replace(
        Database.configuredClient(Layer.suspend(() => sqliteLayer({ storage: makeDurableObjectStorage() }))),
      ),
    ],
  ),
)

const sessionID = Session.ID.make("ses_bookmark_test")
const created = DateTime.makeUnsafe(0)
const build = Agent.defaultID
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const userRow = (id: SessionMessage.ID, seq: number, text: string) => {
  const { id: _, type, ...data } = encodeMessage(SessionMessage.User.make({ id, type: "user", text, time: { created } }))
  return { id, session_id: sessionID, type, seq, time_created: 0, data }
}

const assistantRow = (id: SessionMessage.ID, seq: number) => {
  const { id: _, type, ...data } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: build, model, content: [], time: { created } }),
  )
  return { id, session_id: sessionID, type, seq, time_created: 0, data }
}

const seedSession = () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return db
  })

const listBookmarks = () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db
      .select()
      .from(MessageBookmarkTable)
      .where(eq(MessageBookmarkTable.session_id, sessionID))
      .orderBy(asc(MessageBookmarkTable.created))
      .all()
      .pipe(Effect.orDie)
  })

describe("Bookmark", () => {
  describe("service", () => {
    it.effect("marks, unmarks, and is idempotent per message", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bookmarks = yield* Bookmark.Service
        const messageID = SessionMessage.ID.make("msg_mark")
        const other = SessionMessage.ID.make("msg_other")

        expect(yield* bookmarks.mark({ sessionID, messageID, text: "first", created: 10 })).toEqual({
          bookmarked: true,
        })
        // Re-marking a bookmarked message keeps the original text and time.
        expect(yield* bookmarks.mark({ sessionID, messageID, text: "changed", created: 20 })).toEqual({
          bookmarked: false,
        })
        expect(yield* bookmarks.mark({ sessionID, messageID: other, text: "second", created: 30 })).toEqual({
          bookmarked: true,
        })
        expect(yield* bookmarks.list(sessionID)).toEqual([
          { sessionID, messageID, text: "first", created: 10 },
          { sessionID, messageID: other, text: "second", created: 30 },
        ])

        expect(yield* bookmarks.unmark(sessionID, messageID)).toEqual({ removed: true })
        expect(yield* bookmarks.unmark(sessionID, messageID)).toEqual({ removed: false })
        expect((yield* bookmarks.list(sessionID)).map((item) => item.messageID)).toEqual([other])
      }),
    )

    it.effect("keeps only the newest 200 bookmarks per session", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bookmarks = yield* Bookmark.Service
        for (let i = 0; i < 205; i++)
          yield* bookmarks.mark({
            sessionID,
            messageID: SessionMessage.ID.make(`msg_${String(i).padStart(3, "0")}`),
            text: `note ${i}`,
            created: i,
          })
        const list = yield* bookmarks.list(sessionID)
        expect(list).toHaveLength(200)
        // The oldest overflow is gone; the newest cap is kept, oldest first.
        expect(list[0]).toMatchObject({ text: "note 5", created: 5 })
        expect(list[199]).toMatchObject({ text: "note 204", created: 204 })
        expect((yield* listBookmarks()).map((row) => row.text)).toEqual(list.map((item) => item.text))
      }),
    )

    it.effect("defaults mark created to the current time", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bookmarks = yield* Bookmark.Service
        yield* TestClock.setTime(1234)
        yield* bookmarks.mark({ sessionID, messageID: SessionMessage.ID.make("msg_now"), text: "now" })
        expect(yield* bookmarks.list(sessionID)).toEqual([
          { sessionID, messageID: SessionMessage.ID.make("msg_now"), text: "now", created: 1234 },
        ])
      }),
    )

    it.effect("upserts my messages and lists them oldest first", () =>
      Effect.gen(function* () {
        const db = yield* seedSession()
        const bookmarks = yield* Bookmark.Service
        const messageID = SessionMessage.ID.make("msg_a")
        yield* Bookmark.insertMyMessage(db, { sessionID, messageID, ordinal: 0, text: "hello", created: 10 })
        // Same key twice: the upsert is a no-op, so re-projection never duplicates a row.
        yield* Bookmark.insertMyMessage(db, { sessionID, messageID, ordinal: 0, text: "changed", created: 10 })
        yield* Bookmark.insertMyMessage(db, { sessionID, messageID, ordinal: 1, text: "answer", created: 20 })
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([
          { sessionID, messageID, text: "hello", created: 10 },
          { sessionID, messageID, text: "answer", created: 20 },
        ])
      }),
    )
  })

  describe("projection", () => {
    it.effect("records the user's text as a my message at delivery", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service

        yield* bus.publish(SessionEvent.InboxEnqueued, {
          sessionID,
          inboxID: SessionMessage.ID.make("msg_user"),
          item: { type: "user", payload: { text: "typed by the user" }, delivery: "steer" },
        })
        // Admitted but not yet delivered is not a my message.
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([])

        yield* TestClock.setTime(5)
        yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: SessionMessage.ID.make("msg_user") })
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([
          { sessionID, messageID: SessionMessage.ID.make("msg_user"), text: "typed by the user", created: 5 },
        ])
      }),
    )

    it.effect("records question answers as my messages when the tool completes", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service
        const assistantMessageID = SessionMessage.ID.make("msg_question")
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: build,
          model,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Tool.Input.Started, {
          sessionID,
          assistantMessageID,
          id: "q1",
          name: "question",
        })
        yield* bus.publish(SessionEvent.Tool.Called, {
          sessionID,
          assistantMessageID,
          id: "q1",
          input: {},
          executed: true,
        })
        // No answers selected: nothing to record.
        yield* bus.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          id: "q1",
          content: [{ type: "text", text: "asked" }],
          metadata: { answers: [[], []] },
          executed: true,
        })
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([])

        yield* bus.publish(SessionEvent.Tool.Input.Started, {
          sessionID,
          assistantMessageID,
          id: "q2",
          name: "question",
        })
        yield* bus.publish(SessionEvent.Tool.Called, {
          sessionID,
          assistantMessageID,
          id: "q2",
          input: {},
          executed: true,
        })
        yield* bus.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          id: "q2",
          content: [{ type: "text", text: "asked" }],
          metadata: { answers: [["Yes", "Maybe"], ["No"]] },
          executed: true,
        })
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([
          { sessionID, messageID: assistantMessageID, text: "Yes, Maybe · No", created: 0 },
        ])
      }),
    )

    it.effect("ignores answer metadata on non-question tools", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service
        const assistantMessageID = SessionMessage.ID.make("msg_other_tool")
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: build,
          model,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: "r1", name: "read" })
        yield* bus.publish(SessionEvent.Tool.Called, {
          sessionID,
          assistantMessageID,
          id: "r1",
          input: {},
          executed: true,
        })
        yield* bus.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          id: "r1",
          content: [{ type: "text", text: "export {}" }],
          metadata: { answers: [["sneaky"]] },
          executed: true,
        })
        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([])
      }),
    )

    it.effect("bookmarks a completed assistant message with a marker line", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service
        const assistantMessageID = SessionMessage.ID.make("msg_marked")
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: build,
          model,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: `Report.\n\n  ${Bookmark.BOOKMARK_MARKER}\nDetails.`,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.make(0),
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        // The marker line is dropped and whitespace collapsed; the rest of the report survives.
        expect(yield* bookmarks.list(sessionID)).toEqual([
          { sessionID, messageID: assistantMessageID, text: "Report. Details.", created: 0 },
        ])
      }),
    )

    it.effect("leaves messages without a marker line alone", () =>
      Effect.gen(function* () {
        yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service
        const assistantMessageID = SessionMessage.ID.make("msg_plain")
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: build,
          model,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        // The marker must be a line of its own; an inline mention does not count.
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: `I will not say ${Bookmark.BOOKMARK_MARKER} here`,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.make(0),
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        expect(yield* bookmarks.list(sessionID)).toEqual([])
      }),
    )

    it.effect("drops bookmark and my-message rows when a revert deletes their messages", () =>
      Effect.gen(function* () {
        const db = yield* seedSession()
        const bus = yield* Bus.Service
        const bookmarks = yield* Bookmark.Service
        const keep = SessionMessage.ID.make("msg_keep")
        const drop = SessionMessage.ID.make("msg_drop")
        const reply = SessionMessage.ID.make("msg_reply")
        yield* db
          .insert(SessionMessageTable)
          .values([userRow(keep, 0, "keep me"), userRow(drop, 1, "drop me"), assistantRow(reply, 2)])
          .run()
          .pipe(Effect.orDie)
        yield* Bookmark.insertMyMessage(db, { sessionID, messageID: keep, ordinal: 0, text: "keep me", created: 1 })
        yield* Bookmark.insertMyMessage(db, { sessionID, messageID: drop, ordinal: 0, text: "drop me", created: 2 })
        yield* Bookmark.insertBookmark(db, { sessionID, messageID: reply, text: "dropped note", created: 3 })
        yield* Bookmark.insertBookmark(db, { sessionID, messageID: keep, text: "kept note", created: 4 })

        // The boundary message itself is deleted too, and its rows go with it.
        yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: drop })

        expect(yield* bookmarks.listMyMessages(sessionID)).toEqual([
          { sessionID, messageID: keep, text: "keep me", created: 1 },
        ])
        expect(yield* bookmarks.list(sessionID)).toEqual([
          { sessionID, messageID: keep, text: "kept note", created: 4 },
        ])
      }),
    )
  })
})
