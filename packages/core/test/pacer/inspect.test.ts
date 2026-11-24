import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerInspect } from "@opencode/core/pacer/inspect"
import { PacerModels } from "@opencode/core/pacer/models"
import { catalogOf } from "../memory/fixture"
import { testEffect } from "../lib/effect"

// The service's side of `openforge cpp` (workspace spec docs/specs/cpp-inspect-cli.md, section 5): one read under
// CPP's /pacer/v1/inspect/ with the install's key, CPP's answer passed on unchanged whatever its status, the service's
// own refusals in CPP's error shape, and the variables and token a chat's commands get.

/** A stand-in CPP that records each request's path and key and answers with `answer`. */
const serve = (answer: (url: URL) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: { path: string; authorization: string | null }[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const url = new URL(request.url)
          seen.push({ path: url.pathname + url.search, authorization: request.headers.get("authorization") })
          return answer(url)
        },
      })
      return { seen, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

/**
 * PacerInspect over CPP at `origin` (none: not set up), with `catalog` as CPP's capabilities last said, in a service
 * that listens at 127.0.0.1:47321 unless not `listening` yet.
 */
const inspector = (origin: string | undefined, catalog: PacerModels.Catalog | undefined, listening = true) => {
  const current = origin
    ? PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: "inspect-test-key" }, undefined)
    : undefined
  const endpoints = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({ get: () => Effect.succeed(current), changes: () => Stream.make(current) }),
  )
  const models = Layer.succeed(
    PacerModels.Service,
    PacerModels.Service.of({
      get: () => Effect.succeed(catalog),
      changes: () => Stream.make(catalog),
      refresh: () => Effect.void,
    }),
  )
  return PacerInspect.layer({ url: () => (listening ? "http://127.0.0.1:47321" : undefined) }).pipe(
    Layer.provide(PacerHttp.layer.pipe(Layer.provide(endpoints), Layer.provide(FetchHttpClient.layer))),
    Layer.provide([endpoints, models]),
  )
}

const withInspect = <A, E>(
  layer: ReturnType<typeof inspector>,
  use: (inspect: PacerInspect.Interface) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const inspect = yield* PacerInspect.Service
    return yield* use(inspect)
  }).pipe(Effect.provide(layer))

const inspecting = catalogOf(true, { inspect: true })
const it = testEffect(Layer.empty)

describe("PacerInspect", () => {
  it.live("passes CPP's answer on unchanged, a refusal too, and reads under /pacer/v1/inspect/ with the key", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((url) =>
        url.pathname.endsWith("/tasks")
          ? new Response("- [t1] Rotate keys (active)\n", {
              headers: { "content-type": "text/plain; charset=utf-8", "x-pacer-next": "abc.50" },
            })
          : new Response('{"error":{"type":"project_forbidden","message":"closed"}}', {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
      )
      const [tasks, closed] = yield* withInspect(inspector(cpp.origin, inspecting), (inspect) =>
        Effect.all([inspect.relay("projects/theorysnap/tasks?format=text"), inspect.relay("projects/other/goals")]),
      )
      expect(tasks).toEqual({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        next: "abc.50",
        body: "- [t1] Rotate keys (active)\n",
      })
      expect(closed).toEqual({
        status: 403,
        contentType: "application/json",
        body: '{"error":{"type":"project_forbidden","message":"closed"}}',
      })
      expect(cpp.seen).toEqual([
        { path: "/pacer/v1/inspect/projects/theorysnap/tasks?format=text", authorization: "Bearer inspect-test-key" },
        { path: "/pacer/v1/inspect/projects/other/goals", authorization: "Bearer inspect-test-key" },
      ])
    }),
  )

  it.live("asks a CPP whose capabilities aren't known yet, and refuses for one from before inspection", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => Response.json({ projects: [] }))
      const unknown = yield* withInspect(inspector(cpp.origin, undefined), (inspect) => inspect.relay("projects"))
      expect(unknown.status).toBe(200)
      const refusal = {
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { type: "no_inspection", message: PacerInspect.NO_INSPECTION } }),
      }
      for (const catalog of [catalogOf(true), catalogOf("no pacer")])
        expect(yield* withInspect(inspector(cpp.origin, catalog), (inspect) => inspect.relay("projects"))).toEqual(
          refusal,
        )
      expect(cpp.seen.length).toBe(1)
    }),
  )

  it.live("says when no CPP is set up, and when CPP can't be reached", () =>
    Effect.gen(function* () {
      const none = yield* withInspect(inspector(undefined, inspecting), (inspect) => inspect.relay("projects"))
      expect(none).toEqual({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { type: "not_set_up", message: PacerInspect.NO_CPP } }),
      })
      const gateway = yield* serve(() => new Response("bad gateway", { status: 502 }))
      const down = yield* withInspect(inspector(gateway.origin, inspecting), (inspect) => inspect.relay("projects"))
      expect(down.status).toBe(502)
      expect(JSON.parse(down.body)).toEqual({
        error: { type: "unreachable", message: `CLIProxyPacer can't be reached at ${gateway.origin} now: HTTP 502.` },
      })
      const elsewhere = yield* serve(() => Response.json({ ok: true }))
      const redirecting = yield* serve(() => Response.redirect(`${elsewhere.origin}/collect`, 302))
      const moved = yield* withInspect(inspector(redirecting.origin, inspecting), (inspect) =>
        inspect.relay("projects"),
      )
      expect(moved.status).toBe(502)
      expect(elsewhere.seen).toEqual([])
    }),
  )

  it.live("gives commands the service's address and a token of this start, which it alone accepts", () =>
    Effect.gen(function* () {
      const [env, accepts] = yield* withInspect(inspector(undefined, inspecting), (inspect) =>
        Effect.succeed([inspect.env(), inspect.accepts] as const),
      )
      expect(Object.keys(env)).toEqual([PacerInspect.URL_VARIABLE, PacerInspect.TOKEN_VARIABLE])
      expect(env[PacerInspect.URL_VARIABLE]).toBe("http://127.0.0.1:47321")
      const token = env[PacerInspect.TOKEN_VARIABLE] ?? ""
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(accepts(token)).toBe(true)
      expect([accepts(""), accepts(`${token}A`), accepts(token.slice(1)), accepts(`${token.slice(0, 42)}=`)]).toEqual([
        false,
        false,
        false,
        false,
      ])
      // Another start makes another token, and the one before opens nothing.
      const next = yield* withInspect(inspector(undefined, inspecting), (inspect) => Effect.succeed(inspect))
      expect(next.env()[PacerInspect.TOKEN_VARIABLE]).not.toBe(token)
      expect(next.accepts(token)).toBe(false)
      // A service that doesn't listen yet gives none.
      const silent = yield* withInspect(inspector(undefined, inspecting, false), (inspect) =>
        Effect.succeed(inspect.env()),
      )
      expect(silent).toEqual({})
    }),
  )
})
