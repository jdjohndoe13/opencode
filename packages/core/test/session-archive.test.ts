import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("Session.archive", () => {
  it.effect("archives and unarchives through one durable event each", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      expect(created.time.archived).toBeUndefined()

      yield* session.archive(created.id)
      yield* session.archive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeDefined()

      yield* session.unarchive(created.id)
      yield* session.unarchive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()

      const types = (yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()).map((event) => event.type)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Archived.type, 1))).toHaveLength(1)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Unarchived.type, 1))).toHaveLength(1)
    }),
  )

  it.effect("filters listed sessions by archive state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const active = yield* session.create({ location })
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      const ids = (input?: Session.ListInput) =>
        session.list(input).pipe(Effect.map((page) => page.data.map((item) => item.id).toSorted()))
      expect(yield* ids()).toEqual([active.id, archived.id].toSorted())
      expect(yield* ids({ archived: false })).toEqual([active.id])
      expect(yield* ids({ archived: true })).toEqual([archived.id])
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing_archive")
      expect(yield* Effect.flip(session.archive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
      expect(yield* Effect.flip(session.unarchive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
    }),
  )
})

describe("Session archived read-only gate", () => {
  // The gate runs before prompt preparation, so these stay cheap: no location services boot.
  it.effect("refuses new messages on an archived session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      expect(yield* Effect.flip(session.prompt({ sessionID: archived.id, text: "hello" }))).toEqual(
        new Session.ArchivedError({ sessionID: archived.id }),
      )
      expect(yield* Effect.flip(session.synthetic({ sessionID: archived.id, text: "notice" }))).toEqual(
        new Session.ArchivedError({ sessionID: archived.id }),
      )
      expect(yield* Effect.flip(session.compact({ sessionID: archived.id }))).toEqual(
        new Session.ArchivedError({ sessionID: archived.id }),
      )
      expect(yield* session.inbox(archived.id)).toEqual([])
    }),
  )

  it.effect("admits the same writes once the session is unarchived", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      yield* session.archive(created.id)
      yield* session.unarchive(created.id)

      // Synthetic admission needs no location services, so the gate is the only thing under test.
      expect(yield* session.synthetic({ sessionID: created.id, text: "notice" })).toMatchObject({
        sessionID: created.id,
        type: "synthetic",
      })
      expect(yield* session.inbox(created.id)).toHaveLength(1)
    }),
  )

  it.effect("keeps metadata writes, reads, and archive control allowed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      yield* session.rename({ sessionID: archived.id, title: "renamed zombie" })
      yield* session.setMetadata({ sessionID: archived.id, metadata: { triaged: true } })
      yield* session.setPermissions({ sessionID: archived.id, permissions: [] })
      const current = yield* session.get(archived.id)
      expect(current.title).toBe("renamed zombie")
      expect(current.time.archived).toBeDefined()
      // Fork stays allowed: the empty-session failure proves the gate did not fire.
      expect(yield* Effect.flip(session.fork({ sessionID: archived.id }))).toEqual(
        new Session.ForkEmptyError({ sessionID: archived.id }),
      )
      // Interrupt is a no-op for an idle Session, not an error.
      expect(yield* session.interrupt(archived.id)).toBeFalse()
    }),
  )
})
