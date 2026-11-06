import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

it.live("creates a child at its parent's location and lists it under the parent", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const create = (body: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(SessionResponse)(await response.json()).data
      })
    const parent = yield* create({ title: "Parent" })
    const child = yield* create({ parentID: parent.id, title: "Child", location: { directory: "/unused" } })
    const response = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session?parentID=${parent.id}`)),
    )
    expect(response.status).toBe(200)
    const children = Schema.decodeUnknownSync(SessionsResponse)(yield* Effect.promise(() => response.json()))

    expect(child).toMatchObject({ parentID: parent.id, location: parent.location })
    expect(children.data.map((session) => session.id)).toEqual([child.id])
  }).pipe(Effect.scoped),
)

it.live("returns not found when creating a child of a missing session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const parentID = Session.ID.create()
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentID, title: "Child" }),
        }),
      ),
    )
    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: parentID,
    })
  }).pipe(Effect.scoped),
)

it.live("refuses a new session's ID that a header cannot carry, and still reads a stored session under one", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const request = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: (await response.json()) as unknown }
      })
    const id = "ses_e5180050ffferB1nij3MJqNzhP"

    // A script's capture that gave the ID twice, one line under the other; a space; a character outside ASCII.
    for (const refused of [`${id}\n${id}`, `${id} ${id}`, "ses_\u00fc"])
      expect(yield* request("/api/session", { id: refused, title: "Refused" })).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequestError",
          kind: "Payload",
          message:
            'Expected a session ID: "ses" and then letters, digits or ASCII punctuation, without spaces, line breaks, other control characters or characters outside ASCII\n  at ["id"]',
        },
      })
    expect((yield* request("/api/session")).body).toMatchObject({ data: [] })

    // The server's own form, and one of a user's own.
    for (const taken of [id, "ses_my-task.2"]) {
      const created = yield* request("/api/session", { id: taken, title: "Taken" })
      expect(created.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionResponse)(created.body).data.id).toBe(taken)
    }

    // Only a new session's ID is checked: a session stored under an ID the check refuses is still read.
    const template = Schema.decodeUnknownSync(SessionResponse)((yield* request(`/api/session/${id}`)).body).data
    const stored = "ses_stored before the check"
    expect(
      (yield* request("/api/experimental/session/import", { info: { ...template, id: stored }, messages: [] })).status,
    ).toBe(200)
    const read = yield* request(`/api/session/${encodeURIComponent(stored)}`)
    expect(read.status).toBe(200)
    expect(Schema.decodeUnknownSync(SessionResponse)(read.body).data.id).toBe(stored)
  }).pipe(Effect.scoped),
)
