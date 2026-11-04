import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
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
