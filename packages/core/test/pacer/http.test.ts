import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { testEffect } from "../lib/effect"

type Seen = {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: string
}

/** A local server that records every request it gets and answers with `answer`. */
const serve = (answer: (request: Request, url: URL) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url)
          seen.push({
            method: request.method,
            path: url.pathname + url.search,
            authorization: request.headers.get("authorization"),
            body: await request.text(),
          })
          return answer(request, url)
        },
      })
      return { seen, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

const endpoint = (origin: string, prefix = "", key = "test-key") =>
  PacerEndpoint.resolve({ baseURL: `${origin}${prefix}/v1`, apiKey: key }, undefined)

const services = (current: PacerEndpoint.Endpoint | undefined) =>
  PacerHttp.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PacerEndpoint.Service,
        PacerEndpoint.Service.of({ get: () => Effect.succeed(current), changes: () => Stream.make(current) }),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  )

/** Runs `use` with a PacerHttp whose current endpoint is `current`. */
const withHttp = <A, E>(
  current: PacerEndpoint.Endpoint | undefined,
  use: (http: PacerHttp.Interface) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    return yield* use(http)
  }).pipe(Effect.provide(services(current)))

/** The typed failure; a success fails the test. */
const failure = Effect.flip

const Ok = Schema.Struct({ ok: Schema.Boolean })
const it = testEffect(Layer.empty)

describe("PacerHttp", () => {
  it.live("reads JSON under the endpoint's root with the key as Bearer", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => Response.json({ ok: true, extra: 1 }))
      const answer = yield* withHttp(endpoint(cpp.origin, "/proxy"), (http) =>
        http.get("/pacer/v1/sessions?children=1", Ok),
      )
      expect(answer.body).toEqual({ ok: true })
      expect(cpp.seen).toEqual([
        { method: "GET", path: "/proxy/pacer/v1/sessions?children=1", authorization: "Bearer test-key", body: "" },
      ])
    }),
  )

  it.live("sends PATCH and POST bodies as JSON", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((request) =>
        Response.json({ ok: request.headers.get("content-type")?.startsWith("application/json") === true }),
      )
      const patched = yield* withHttp(endpoint(cpp.origin), (http) =>
        http.patch("/pacer/v1/sessions/abc", { model: "m" }, Ok),
      )
      const posted = yield* withHttp(endpoint(cpp.origin), (http) =>
        http.post("/pacer/v1/sessions/abc/events", { type: "closed" }, Ok),
      )
      expect([patched.body, posted.body]).toEqual([{ ok: true }, { ok: true }])
      expect(cpp.seen.map((item) => [item.method, item.path, JSON.parse(item.body)])).toEqual([
        ["PATCH", "/pacer/v1/sessions/abc", { model: "m" }],
        ["POST", "/pacer/v1/sessions/abc/events", { type: "closed" }],
      ])
    }),
  )

  it.live("calls the endpoint it is given instead of the current one", () =>
    Effect.gen(function* () {
      const current = yield* serve(() => Response.json({ ok: false }))
      const given = yield* serve(() => Response.json({ ok: true }))
      const answer = yield* withHttp(endpoint(current.origin), (http) =>
        http.get("/healthz", Ok, { endpoint: endpoint(given.origin, "", "given-key") }),
      )
      expect(answer.body).toEqual({ ok: true })
      expect(current.seen).toEqual([])
      expect(given.seen.map((item) => item.authorization)).toEqual(["Bearer given-key"])
    }),
  )

  it.live("refuses a redirect without following it, so the key never reaches its target", () =>
    Effect.gen(function* () {
      const target = yield* serve(() => Response.json({ ok: true }))
      const cpp = yield* serve(() => Response.redirect(`${target.origin}/collect`, 302))
      const error = yield* failure(withHttp(endpoint(cpp.origin), (http) => http.get("/pacer/v1/capabilities", Ok)))
      expect(error).toBeInstanceOf(PacerHttp.Unexpected)
      expect(error).toMatchObject({ status: 302 })
      const streamed = yield* failure(withHttp(endpoint(cpp.origin), (http) => http.stream("/pacer/v1/stream")))
      expect(streamed).toMatchObject({ _tag: "PacerHttp.Unexpected", status: 302 })
      expect(cpp.seen.map((item) => item.authorization)).toEqual(["Bearer test-key", "Bearer test-key"])
      expect(target.seen).toEqual([])
    }),
  )

  it.live("never sends a request for a path that would leave the endpoint's origin", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => Response.json({ ok: true }))
      const other = yield* serve(() => Response.json({ ok: true }))
      for (const path of [`@${new URL(other.origin).host}/x`, "pacer/v1/state", `${other.origin}/x`]) {
        const exit = yield* Effect.exit(withHttp(endpoint(cpp.origin), (http) => http.get(path, Ok)))
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      }
      expect([cpp.seen, other.seen]).toEqual([[], []])
    }),
  )

  it.live("fails NotSetUp without an endpoint and sends nothing", () =>
    Effect.gen(function* () {
      const error = yield* failure(withHttp(undefined, (http) => http.get("/pacer/v1/state", Ok)))
      expect(error).toBeInstanceOf(PacerHttp.NotSetUp)
    }),
  )

  it.live("takes the server's clock offset from the Date header", () =>
    Effect.gen(function* () {
      const ahead = 3_600_000
      const cpp = yield* serve((_, url) =>
        Response.json(
          { ok: true },
          { headers: { date: url.pathname === "/bad" ? "not a date" : new Date(Date.now() + ahead).toUTCString() } },
        ),
      )
      const answer = yield* withHttp(endpoint(cpp.origin), (http) => http.get("/good", Ok))
      // Date has whole seconds, so the server's clock reads up to a second early.
      expect(answer.offset).toBeGreaterThan(ahead - 2_000)
      expect(answer.offset).toBeLessThanOrEqual(ahead)
      const bad = yield* withHttp(endpoint(cpp.origin), (http) => http.get("/bad", Ok))
      expect(bad.offset).toBeUndefined()
    }),
  )

  it.live("fails Unreachable when no answer comes in time", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => new Promise<Response>(() => {}))
      const error = yield* failure(
        withHttp(endpoint(cpp.origin), (http) => http.get("/pacer/v1/state", Ok, { timeout: "200 millis" })),
      )
      expect(error).toBeInstanceOf(PacerHttp.Unreachable)
      expect(error.message).toBe("CLIProxyPacer is unreachable: no answer within 200ms")
    }),
  )

  it.live("fails Unreachable when nothing listens", () =>
    Effect.gen(function* () {
      const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
      const origin = `http://127.0.0.1:${closed.port}`
      yield* Effect.promise(() => closed.stop(true))
      const error = yield* failure(withHttp(endpoint(origin), (http) => http.get("/pacer/v1/state", Ok)))
      expect(error).toBeInstanceOf(PacerHttp.Unreachable)
    }),
  )

  it.live("sorts error answers into their classes", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((_, url) => {
        const error = (status: number, type: string, headers?: Record<string, string>) =>
          Response.json({ error: { type, message: `${type} message` } }, { status, headers })
        switch (url.pathname) {
          case "/500":
            return error(500, "internal")
          case "/502":
            return new Response("bad gateway", { status: 502 })
          case "/busy":
            return error(503, "busy", { "retry-after": "1" })
          case "/unavailable":
            return error(503, "unavailable")
          case "/401":
            return error(401, "unauthorized")
          case "/403":
            return new Response("forbidden", { status: 403 })
          case "/not-found":
            return error(404, "not_found")
          case "/no-route":
            return new Response("404 page not found", { status: 404 })
          case "/400":
            return error(400, "invalid_request")
          case "/not-json":
            return new Response("<html></html>", { status: 200 })
          case "/wrong-shape":
            return Response.json({ ok: "yes" })
        }
        return new Response(null, { status: 418 })
      })
      const classify = (path: string) =>
        failure(withHttp(endpoint(cpp.origin), (http) => http.get(path, Ok))).pipe(
          Effect.map((error) => ({
            tag: error._tag,
            status: "status" in error ? error.status : undefined,
            retryAfter: "retryAfter" in error ? error.retryAfter : undefined,
          })),
        )
      const results = yield* Effect.forEach(
        [
          "/500",
          "/502",
          "/busy",
          "/unavailable",
          "/401",
          "/403",
          "/not-found",
          "/no-route",
          "/400",
          "/not-json",
          "/wrong-shape",
        ],
        classify,
      )
      expect(results).toEqual([
        { tag: "PacerHttp.Unreachable", status: 500, retryAfter: undefined },
        { tag: "PacerHttp.Unreachable", status: 502, retryAfter: undefined },
        { tag: "PacerHttp.Unreachable", status: 503, retryAfter: 1000 },
        { tag: "PacerHttp.NoPacer", status: 503, retryAfter: undefined },
        { tag: "PacerHttp.Refused", status: 401, retryAfter: undefined },
        { tag: "PacerHttp.Refused", status: 403, retryAfter: undefined },
        { tag: "PacerHttp.NotFound", status: undefined, retryAfter: undefined },
        { tag: "PacerHttp.NoPacer", status: 404, retryAfter: undefined },
        { tag: "PacerHttp.Unexpected", status: 400, retryAfter: undefined },
        { tag: "PacerHttp.Unexpected", status: 200, retryAfter: undefined },
        { tag: "PacerHttp.Unexpected", status: 200, retryAfter: undefined },
      ])
      const refused = yield* failure(withHttp(endpoint(cpp.origin), (http) => http.get("/401", Ok)))
      expect(refused.message).toContain("unauthorized message")
      // Errors carry no request, so logging one never prints the key.
      expect(JSON.stringify(refused)).not.toContain("test-key")
    }),
  )

  it.live("fails NoPacer on capabilities that say pacer: null", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((_, url) => Response.json({ pacer: url.pathname === "/plain" ? null : { warming: {} } }))
      const Capabilities = Schema.Struct({ pacer: Schema.NullOr(Schema.Struct({ warming: Schema.Struct({}) })) })
      const plain = yield* failure(
        withHttp(endpoint(cpp.origin), (http) =>
          http.get("/plain", Capabilities).pipe(Effect.flatMap(PacerHttp.requirePacer)),
        ),
      )
      expect(plain).toBeInstanceOf(PacerHttp.NoPacer)
      const paced = yield* withHttp(endpoint(cpp.origin), (http) =>
        http.get("/paced", Capabilities).pipe(Effect.flatMap(PacerHttp.requirePacer)),
      )
      expect(paced.body.pacer.warming).toEqual({})
    }),
  )

  it.live("streams the raw body as it arrives", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((_, url) => {
        if (url.pathname === "/refused") return new Response("no", { status: 401 })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: resync\ndata: {}\n\n"))
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream", date: new Date(Date.now() + 60_000).toUTCString() } },
        )
      })
      const answer = yield* withHttp(endpoint(cpp.origin), (http) =>
        http.stream("/pacer/v1/stream", { headers: { accept: "text/event-stream" } }),
      )
      expect(answer.headers["content-type"]).toBe("text/event-stream")
      expect(answer.offset).toBeGreaterThan(58_000)
      const text = yield* answer.body.pipe(Stream.decodeText(), Stream.mkString)
      expect(text).toBe("event: resync\ndata: {}\n\n: heartbeat\n\n")
      const refused = yield* failure(withHttp(endpoint(cpp.origin), (http) => http.stream("/refused")))
      expect(refused).toBeInstanceOf(PacerHttp.Refused)
      expect(cpp.seen.map((item) => item.authorization)).toEqual(["Bearer test-key", "Bearer test-key"])
    }),
  )
})
