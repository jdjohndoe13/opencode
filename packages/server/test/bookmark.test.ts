import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("manages bookmarks and my messages through the experimental API", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-bookmark-api-")).path
    const global = path.join(dir, "global")
    const project = path.join(dir, "project")
    yield* Effect.promise(async () => {
      await Promise.all([global, project].map((item) => fs.mkdir(item, { recursive: true })))
    })
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = client(handler)
    const sessionID = "ses_bookmark_api"

    yield* Effect.promise(async () => {
      const session = await api.session.create({ location: { directory: project } })
      const messageID = "msg_api_1"
      const other = "msg_api_2"

      // Empty to start.
      expect(await api.experimental.bookmark.list({ sessionID: session.id })).toEqual([])
      expect(await api.experimental.myMessage.list({ sessionID: session.id })).toEqual([])

      // Mark is idempotent: the first call adds, the second keeps the original snapshot.
      expect(
        await api.experimental.bookmark.mark({ sessionID: session.id, messageID, text: "first", created: 10 }),
      ).toEqual({ bookmarked: true })
      expect(
        await api.experimental.bookmark.mark({ sessionID: session.id, messageID, text: "changed", created: 20 }),
      ).toEqual({ bookmarked: false })
      expect(
        await api.experimental.bookmark.mark({ sessionID: session.id, messageID: other, text: "second", created: 30 }),
      ).toEqual({ bookmarked: true })
      expect(await api.experimental.bookmark.list({ sessionID: session.id })).toEqual([
        { sessionID: session.id, messageID, text: "first", created: 10 },
        { sessionID: session.id, messageID: other, text: "second", created: 30 },
      ])

      expect(await api.experimental.bookmark.unmark({ sessionID: session.id, messageID })).toEqual({ removed: true })
      expect(await api.experimental.bookmark.unmark({ sessionID: session.id, messageID })).toEqual({ removed: false })
      expect((await api.experimental.bookmark.list({ sessionID: session.id })).map((item) => item.messageID)).toEqual([
        other,
      ])

      // Unknown sessions answer 404.
      await expect(api.experimental.bookmark.list({ sessionID })).rejects.toMatchObject({
        _tag: "SessionNotFoundError",
      })
      await expect(
        api.experimental.bookmark.mark({ sessionID, messageID, text: "nope" }),
      ).rejects.toMatchObject({ _tag: "SessionNotFoundError" })
      await expect(api.experimental.bookmark.unmark({ sessionID, messageID })).rejects.toMatchObject({
        _tag: "SessionNotFoundError",
      })
      await expect(api.experimental.myMessage.list({ sessionID })).rejects.toMatchObject({
        _tag: "SessionNotFoundError",
      })
    })
  }),
)
