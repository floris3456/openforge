import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { createResender, OpenCode } from "@opencode/client"
import { ServiceSwitch } from "@opencode/protocol/service-switch"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import path from "node:path"
import { HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

/** A server over a database file, which the next server starts from as a release switch does. */
const onFile = (database: string) => ({
  hostname: "127.0.0.1",
  port: 0,
  password: "secret",
  app: { version: "test-version" },
  database: { path: database },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
})
const authorization = `Basic ${btoa("opencode:secret")}`

it.live("a paused start answers reads and refuses writes until it is resumed", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      paused: true,
    })
    const request = (path: string, init: RequestInit = {}) =>
      Effect.promise(() =>
        fetch(new URL(path, HttpServer.formatAddress(server.address)), {
          ...init,
          headers: { authorization, "content-type": "application/json" },
        }),
      )

    const status = yield* request("/api/experimental/service/status")
    expect(status.status).toBe(200)
    expect(yield* Effect.promise(() => status.json())).toMatchObject({
      data: { state: "paused", startedPaused: true, waiting: [], rested: [], active: [] },
    })
    expect((yield* request("/api/session")).status).toBe(200)

    const refused = yield* request("/api/session", { method: "POST", body: "{}" })
    expect(refused.status).toBe(503)
    expect(refused.headers.get("retry-after")).toBe("1")
    expect(yield* Effect.promise(() => refused.json())).toEqual(ServiceSwitch.refused)

    const resumed = yield* request("/api/experimental/service/resume", { method: "POST" })
    expect(resumed.status).toBe(200)
    expect(yield* Effect.promise(() => resumed.json())).toMatchObject({
      data: { state: "running", startedPaused: false },
    })
    expect((yield* request("/api/session", { method: "POST", body: "{}" })).status).not.toBe(503)
  }),
)

// A switch that rolls back asks the paused new release to hand the persistent terminals back before it stops it. The
// handoff carries no chat data a rollback could lose.
it.live("a paused start answers the persistent terminals' handoff and still refuses other writes", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      paused: true,
    })
    const post = (path: string) =>
      Effect.promise(() =>
        fetch(new URL(path, HttpServer.formatAddress(server.address)), {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: "{}",
        }),
      )

    const handoff = yield* post(ServiceSwitch.handoff)
    expect(handoff.status).toBe(200)
    // No terminal runs here, so there is nothing to hand on.
    expect(yield* Effect.promise(() => handoff.json())).toEqual({ handoff: null })
    for (const path of ["/api/experimental/persistent-pty/shutdown", "/api/session"]) {
      const refused = yield* post(path)
      expect(refused.status).toBe(503)
      expect(yield* Effect.promise(() => refused.json())).toEqual(ServiceSwitch.refused)
    }
  }),
)

// What a client does during a switch: a write refused by the paused new release is resent with the same id, and goes
// in once, as soon as the service resumes.
it.live("a prompt refused by a paused start is resent with the same id and taken once after resume", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped("openforge-pause-resend-")
    const options = onFile(path.join(directory.path, "opencode.db"))
    const sessionID = Session.ID.create()
    // The release before the switch: the chat exists.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* ServerProcess.start<never, never>(options)
        const api = OpenCode.make({ baseUrl: HttpServer.formatAddress(server.address), headers: { authorization } })
        yield* Effect.promise(() => api.session.create({ id: sessionID, title: "switching" }))
      }),
    )

    // The new release starts paused.
    const server = yield* ServerProcess.start<never, never>({ ...options, paused: true })
    const refused = Promise.withResolvers<string>()
    const resender = createResender()
    const api = OpenCode.make({
      baseUrl: HttpServer.formatAddress(server.address),
      headers: { authorization },
      fetch: resender.fetch(
        Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const response = await fetch(input, init)
            if (response.status === 503) refused.resolve(new URL(input instanceof Request ? input.url : input).pathname)
            return response
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    })
    const prompt = { sessionID, id: "msg_switch_once", text: "Carry on", resume: false }
    const sent = api.session.prompt(prompt)
    expect(yield* Effect.promise(() => refused.promise)).toBe(`/api/session/${sessionID}/prompt`)

    yield* Effect.promise(() => api.experimental.service.resume())
    // What the client's event stream reports once the new release resumed.
    resender.observe({ type: "service.resumed" })
    expect((yield* Effect.promise(() => sent)).id).toBe("msg_switch_once")
    // The same prompt again, as a client that never saw the answer would send it: still one item.
    yield* Effect.promise(() => api.session.prompt(prompt))
    const inbox = yield* Effect.promise(() => api.session.inbox.list({ sessionID }))
    expect(inbox.map((item) => item.id)).toEqual(["msg_switch_once"])
  }),
)

/** A chat whose question the release before the switch asked, as its question tool stored it; no tool asks it yet. */
const storedQuestion = (prefix: string) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped(prefix)
    const options = onFile(path.join(directory.path, "opencode.db"))
    const sessionID = Session.ID.create()
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* ServerProcess.start<never, never>(options)
        const api = OpenCode.make({ baseUrl: HttpServer.formatAddress(server.address), headers: { authorization } })
        yield* Effect.promise(() => api.session.create({ id: sessionID, title: "asking" }))
      }),
    )
    // What the question tool of the release before the switch stored when it asked.
    const formID = "frm_1a7cd5f840018NKKqEQn7PUjh2"
    const form = {
      id: formID,
      sessionID,
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_1a7cd5f5a00161M4H4ckI1qsFH", id: "call_question" } },
      fields: [
        {
          key: "q0",
          title: "Continue",
          description: "Continue?",
          type: "string",
          options: [{ value: "Yes", label: "Yes" }],
        },
      ],
    }
    yield* Effect.sync(() => {
      using db = new Database(options.database.path)
      db.run(
        "INSERT INTO pending_request (id, session_id, kind, message_id, call_id, request, time_created, time_updated) VALUES (?, ?, 'form', ?, ?, ?, ?, ?)",
        [
          formID,
          sessionID,
          form.metadata.tool.messageID,
          form.metadata.tool.id,
          JSON.stringify(form),
          Date.now(),
          Date.now(),
        ],
      )
    })
    const server = yield* ServerProcess.start<never, never>(options)
    const send = (method: string, session: string, path: string, body?: unknown) =>
      Effect.promise(() =>
        fetch(new URL(`/api/session/${session}/form/${formID}${path}`, HttpServer.formatAddress(server.address)), {
          method,
          headers: { authorization, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
    const stored = Effect.sync(() => {
      using db = new Database(options.database.path, { readonly: true })
      const row = db.query<{ reply: string }, [string]>("SELECT reply FROM pending_request WHERE id = ?").get(formID)
      return JSON.parse(row?.reply ?? "null") as unknown
    })
    return { sessionID, send, stored }
  })

// An answer resent through a switch can reach the new release before the question's tool asks again: it is kept for
// the rerun, not refused as an unknown question.
it.live("an answer to a question asked before the switch is taken before its tool asks again", () =>
  Effect.gen(function* () {
    const question = yield* storedQuestion("openforge-pause-answer-")
    const reply = (session: string) => question.send("POST", session, "/reply", { answer: { q0: "Yes" } })
    expect((yield* reply(Session.ID.create())).status).toBe(404)
    expect((yield* reply(question.sessionID)).status).toBe(204)
    // Resent, it gets the same success.
    expect((yield* reply(question.sessionID)).status).toBe(204)
    expect(yield* question.stored).toEqual({ q0: "Yes" })
  }),
)

// So is a dismissal: the rerun of the question tool finds the question dismissed and does not ask it again.
it.live("a dismissal of a question asked before the switch is taken before its tool asks again", () =>
  Effect.gen(function* () {
    const question = yield* storedQuestion("openforge-pause-dismiss-")
    const dismiss = (session: string) => question.send("DELETE", session, "")
    expect((yield* dismiss(Session.ID.create())).status).toBe(404)
    expect((yield* dismiss(question.sessionID)).status).toBe(204)
    // Resent, it gets the same success; an answer after it is too late.
    expect((yield* dismiss(question.sessionID)).status).toBe(204)
    expect((yield* question.send("POST", question.sessionID, "/reply", { answer: { q0: "Yes" } })).status).toBe(409)
    expect(yield* question.stored).toEqual({ cancelled: {} })
  }),
)
