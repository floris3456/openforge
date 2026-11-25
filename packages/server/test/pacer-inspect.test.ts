import { expect } from "bun:test"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerInspect } from "@opencode/core/pacer/inspect"
import { PacerModels } from "@opencode/core/pacer/models"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { HttpServer } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

// The service's inspection routes (workspace spec docs/specs/cpp-inspect-cli.md, section 5) against a stand-in
// CLIProxyPacer that records what it gets: each route reaches CPP's inspection path with the key and only its own
// fields, CPP's answer comes back unchanged, the token of this start opens these routes and no other, the password
// opens them too, and the key's bytes are in no answer.

const KEY = "inspect-test-key-0001"
const PASSWORD = "inspect-test-password"

interface Seen {
  readonly path: string
  readonly authorization: string | null
}

/** A stand-in CPP: its inspection paths answer `answer`, every other path 404, and it keeps what reached it. */
const cpp = (answer: (url: URL) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const url = new URL(request.url)
          if (!url.pathname.startsWith("/pacer/v1/inspect/"))
            return Response.json({ error: { type: "not_found" } }, { status: 404 })
          seen.push({ path: url.pathname + url.search, authorization: request.headers.get("authorization") })
          return answer(url)
        },
      })
      return { seen, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

const catalog = (inspect: boolean): PacerModels.Catalog => ({
  at: 0,
  pacer: {
    compactTokens: ["auto"],
    webTools: false,
    memory: {
      version: 1,
      entryCharacters: 1100,
      queryCharacters: 2000,
      searchLimit: 20,
      embedding: null,
      tasks: true,
      plans: true,
      recalls: true,
      projects: true,
      prompt: true,
      summary: true,
      tools: true,
      goals: true,
      later: true,
      reviewItems: false,
      reviewOwed: false,
      inspect,
      identities: false,
    },
  },
  models: [],
})

/** The service on a port of its own, CPP at `origin`, and the inspection service this start made. */
const service = Effect.fnUntraced(function* (origin: string | undefined, inspect = true) {
  const endpoint =
    origin === undefined ? undefined : PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: KEY }, undefined)
  const made = yield* Deferred.make<PacerInspect.Interface>()
  let address = ""
  const server = yield* ServerProcess.start<never, never>(
    { hostname: "127.0.0.1", port: 0, password: PASSWORD, app: { version: "test" }, database: { path: ":memory:" } },
    undefined,
    undefined,
    undefined,
    [
      PacerEndpoint.node.replace(
        makeGlobalNode({
          service: PacerEndpoint.Service,
          layer: Layer.succeed(
            PacerEndpoint.Service,
            PacerEndpoint.Service.of({ get: () => Effect.succeed(endpoint), changes: () => Stream.make(endpoint) }),
          ),
          deps: [],
        }),
      ),
      PacerModels.node.replace(
        makeGlobalNode({
          service: PacerModels.Service,
          layer: Layer.succeed(
            PacerModels.Service,
            PacerModels.Service.of({
              get: () => Effect.succeed(catalog(inspect)),
              changes: () => Stream.make(catalog(inspect)),
              refresh: () => Effect.void,
            }),
          ),
          deps: [],
        }),
      ),
      PacerInspect.node.replace(
        makeGlobalNode({
          service: PacerInspect.Service,
          layer: PacerInspect.layer({ url: () => address }).pipe(
            Layer.tap((context) => Deferred.succeed(made, Context.get(context, PacerInspect.Service))),
          ),
          deps: [PacerHttp.node, PacerEndpoint.node, PacerModels.node],
        }),
      ),
    ],
  )
  address = HttpServer.formatAddress(server.address)
  const env = (yield* Deferred.await(made)).env()
  const call = (path: string, authorization?: string) =>
    Effect.promise(async () => {
      const response = await fetch(new URL(path, address), authorization ? { headers: { authorization } } : undefined)
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        next: response.headers.get("x-pacer-next"),
        body: await response.text(),
      }
    })
  return { address, env, call, bearer: `Bearer ${env[PacerInspect.TOKEN_VARIABLE]}` }
})

const basic = `Basic ${btoa(`openforge:${PASSWORD}`)}`

it.live("relays each route to CPP's inspection path with the key and its own fields, the answer unchanged", () =>
  Effect.gen(function* () {
    const stand = yield* cpp((url) =>
      url.pathname.endsWith("/review")
        ? new Response(JSON.stringify({ error: { type: "project_forbidden", message: "closed" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          })
        : new Response(`read ${url.pathname}`, {
            headers: { "content-type": "text/plain; charset=utf-8", "x-pacer-next": "ab12.3f" },
          }),
    )
    const svc = yield* service(stand.origin)
    expect(svc.env).toEqual({
      [PacerInspect.URL_VARIABLE]: svc.address,
      [PacerInspect.TOKEN_VARIABLE]: expect.stringMatching(/^[\w-]{43}$/),
    })
    const routes = [
      ["projects?all=1&cursor=c1&format=text&bogus=1", "/pacer/v1/inspect/projects?all=1&cursor=c1&format=text"],
      [
        "projects/my%20site/tasks?state=done&query=log+rotation&limit=5&cursor=c2&format=text&ids=x",
        "/pacer/v1/inspect/projects/my%20site/tasks?state=done&query=log+rotation&limit=5&cursor=c2&format=text",
      ],
      ["projects/theorysnap/goals?all=1", "/pacer/v1/inspect/projects/theorysnap/goals?all=1"],
      [
        "projects/theorysnap/recall?q=disk&scope=role%3Abuild&kind=verified%2Cwords&limit=3",
        "/pacer/v1/inspect/projects/theorysnap/recall?q=disk&scope=role%3Abuild&kind=verified%2Cwords&limit=3",
      ],
      [
        "projects/theorysnap/entries?role=build&task=t1&kind=words&state=all&limit=9",
        "/pacer/v1/inspect/projects/theorysnap/entries?role=build&task=t1&kind=words&state=all&limit=9",
      ],
      ["items?ids=a1,b2", "/pacer/v1/inspect/items?ids=a1%2Cb2"],
      ["tasks/t%2F1/review?format=text", "/pacer/v1/inspect/tasks/t%2F1/review?format=text"],
    ] as const
    for (const [path, reached] of routes) {
      const answer = yield* svc.call(`/api/experimental/pacer/inspect/${path}`, svc.bearer)
      if (path.startsWith("tasks/")) {
        expect(answer).toEqual({
          status: 403,
          type: "application/json",
          next: null,
          body: JSON.stringify({ error: { type: "project_forbidden", message: "closed" } }),
        })
      } else {
        expect(answer).toEqual({
          status: 200,
          type: "text/plain; charset=utf-8",
          next: "ab12.3f",
          body: `read ${new URL(reached, "http://x").pathname}`,
        })
      }
      expect(answer.body).not.toContain(KEY)
    }
    expect(stand.seen).toEqual(routes.map(([, path]) => ({ path, authorization: `Bearer ${KEY}` })))
  }),
)

it.live("the token of this start opens the inspection routes alone; the password opens them too", () =>
  Effect.gen(function* () {
    const stand = yield* cpp(() => Response.json({ projects: [], next: null }))
    const svc = yield* service(stand.origin)
    const route = "/api/experimental/pacer/inspect/projects"
    expect((yield* svc.call(route, svc.bearer)).status).toBe(200)
    expect((yield* svc.call(route, basic)).status).toBe(200)
    expect((yield* svc.call(route)).status).toBe(401)
    expect((yield* svc.call(route, `Bearer ${"A".repeat(43)}`)).status).toBe(401)
    for (const other of [
      "/api/experimental/pacer/status",
      "/api/info",
      "/openapi.json",
      "/api/experimental/pacer/settings",
    ])
      expect((yield* svc.call(other, svc.bearer)).status).toBe(401)
    expect(stand.seen).toHaveLength(2)
    // A new start of the service makes a new token and refuses the old one.
    const again = yield* service(stand.origin)
    expect(again.bearer).not.toBe(svc.bearer)
    expect((yield* again.call(route, svc.bearer)).status).toBe(401)
    expect((yield* again.call(route, again.bearer)).status).toBe(200)
  }),
)

it.live("answers its own refusals in CPP's shape: no CPP set up, CPP away, a CPP without inspection", () =>
  Effect.gen(function* () {
    const route = "/api/experimental/pacer/inspect/projects/theorysnap/tasks"
    const none = yield* service(undefined)
    expect(yield* none.call(route, none.bearer)).toMatchObject({
      status: 503,
      body: JSON.stringify({ error: { type: "not_set_up", message: PacerInspect.NO_CPP } }),
    })
    // A port nothing listens on.
    const stand = yield* cpp(() => Response.json({}))
    const away = stand.origin
    yield* Effect.promise(() => stand.server.stop(true))
    const gone = yield* service(away)
    const answer = yield* gone.call(route, gone.bearer)
    expect(answer.status).toBe(502)
    expect(JSON.parse(answer.body).error.message).toStartWith(`CLIProxyPacer can't be reached at ${away} now: `)
    expect(answer.body).not.toContain(KEY)
    const older = yield* cpp(() => Response.json({}))
    const old = yield* service(older.origin, false)
    expect(yield* old.call(route, old.bearer)).toMatchObject({
      status: 404,
      body: JSON.stringify({ error: { type: "no_inspection", message: PacerInspect.NO_INSPECTION } }),
    })
    expect(older.seen).toEqual([])
  }),
)
