import { expect } from "bun:test"
import { OpenCode, resend } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import path from "node:path"
import { HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

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
          headers: { authorization: `Basic ${btoa("opencode:secret")}`, "content-type": "application/json" },
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
    expect(yield* Effect.promise(() => refused.json())).toEqual({
      code: "service_switching",
      message: "switching, try again in 1 s",
    })

    const resumed = yield* request("/api/experimental/service/resume", { method: "POST" })
    expect(resumed.status).toBe(200)
    expect(yield* Effect.promise(() => resumed.json())).toMatchObject({ data: { state: "running", startedPaused: false } })
    expect((yield* request("/api/session", { method: "POST", body: "{}" })).status).not.toBe(503)
  }),
)

// What a client does during a switch: a write refused by the paused new release is resent with the same id, and goes
// in once, as soon as the service resumes.
it.live("a prompt refused by a paused start is resent with the same id and taken once after resume", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped("openforge-pause-resend-")
    const database = { path: path.join(directory.path, "opencode.db") }
    const options = {
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database,
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    }
    const authorization = `Basic ${btoa("opencode:secret")}`
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
    const refused: string[] = []
    const api = OpenCode.make({
      baseUrl: HttpServer.formatAddress(server.address),
      headers: { authorization },
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const response = await fetch(input, init)
          if (response.status === 503) refused.push(new URL(input instanceof Request ? input.url : input).pathname)
          return response
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const opened = Promise.withResolvers<void>()
    const prompt = { sessionID, id: "msg_switch_once", text: "Carry on", resume: false }
    const sent = resend(() => api.session.prompt(prompt), { ready: () => opened.promise })
    yield* Effect.promise(async () => {
      while (refused.length < 1) await Bun.sleep(5)
    })
    expect(refused).toEqual([`/api/session/${sessionID}/prompt`])

    yield* Effect.promise(() => api.experimental.service.resume())
    opened.resolve()
    expect((yield* Effect.promise(() => sent)).id).toBe("msg_switch_once")
    // The same prompt again, as a client that never saw the answer would send it: still one item.
    yield* Effect.promise(() => api.session.prompt(prompt))
    const inbox = yield* Effect.promise(() => api.session.inbox.list({ sessionID }))
    expect(inbox.map((item) => item.id)).toEqual(["msg_switch_once"])
  }),
)
