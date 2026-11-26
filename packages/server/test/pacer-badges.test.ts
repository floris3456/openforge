import { expect } from "bun:test"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { catalogOf } from "../../core/test/memory/fixture"
import { eventually, waitUntil } from "../../core/test/lib/eventually"
import { ServerFetch } from "../src/fetch"

// The service's route of the chats' agents' badges (the workspace's spec docs/specs/agent-badges.md, section 3, item 3)
// against a stand-in CLIProxyPacer whose session views carry `agent_badge`: a chat asked about that nothing named is
// read from its view and given from then on; nothing is read or given while CPP's capabilities don't say
// `memory.badges`.

const KEY = "badges-test-key-0001"
const LEAD = SessionID.make("ses_badges_server_lead")
const LONE = SessionID.make("ses_badges_server_lone")
const scheme = { hue: 240, level: 2, opposite: false, background: "#00537C", subject: "#001b2e", detail: "#e6f4ff" }

/** A stand-in CPP: the lead's view with its badge, the lone chat's without an identity; nothing else is found. */
const cpp = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const views: string[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const path = new URL(request.url).pathname
          if (path === `/pacer/v1/sessions/${PacerSessionID.make(LEAD)}`) {
            views.push(path)
            return Response.json({
              id: PacerSessionID.make(LEAD),
              agent_identity: "k3m9x2v7p0qa",
              agent_badge: { scheme },
            })
          }
          if (path === `/pacer/v1/sessions/${PacerSessionID.make(LONE)}`) {
            views.push(path)
            return Response.json({ id: PacerSessionID.make(LONE), agent_identity: null, agent_badge: null })
          }
          return Response.json({ error: { type: "not_found" } }, { status: 404 })
        },
      })
      return { views, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

/** The service in process, CPP at `origin` saying `memory.badges` in its capabilities or not. */
const service = Effect.fnUntraced(function* (origin: string, badges: boolean) {
  const endpoint = PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: KEY }, undefined)
  const catalog = catalogOf(true, { identities: true, badges })
  const handler = yield* ServerFetch.make(
    { app: { version: "test" }, database: { path: ":memory:" }, fs: { filewatcher: false }, models: { fetch: false } },
    {
      overrides: [
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
                get: () => Effect.succeed(catalog),
                changes: () => Stream.make(catalog),
                refresh: () => Effect.void,
              }),
            ),
            deps: [],
          }),
        ),
      ],
    },
  )
  const ask = (sessionIDs: string[]) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request("http://opencode.local/api/experimental/pacer/badges", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionIDs }),
        }),
      )
      return { status: response.status, body: await response.json() }
    })
  return { ask }
})

it.live("gives the badges of the chats asked, read from their views once, the scheme's background and hue", () =>
  Effect.gen(function* () {
    const stand = yield* cpp()
    const svc = yield* service(stand.origin, true)
    // Not known yet: read, and left out.
    expect(yield* svc.ask([LEAD, LONE])).toEqual({ status: 200, body: { data: { items: [] } } })
    yield* waitUntil(Effect.sync(() => stand.views.length === 2))
    const known = {
      items: [
        { sessionID: LEAD, badge: { background: "#00537c", hue: 240 } },
        { sessionID: LONE, badge: null },
      ],
    }
    yield* eventually(svc.ask([LEAD, LONE]), (answer) => Bun.deepEquals(answer.body.data, known))
    // Kept: asked again, nothing is read.
    expect((yield* svc.ask([LEAD, LONE])).body.data).toEqual(known)
    expect(stand.views).toHaveLength(2)
  }),
)

it.live("without memory.badges it reads no view and gives no badge", () =>
  Effect.gen(function* () {
    const stand = yield* cpp()
    const svc = yield* service(stand.origin, false)
    expect(yield* svc.ask([LEAD, LONE])).toEqual({ status: 200, body: { data: { items: [] } } })
    yield* Effect.sleep("200 millis")
    expect((yield* svc.ask([LEAD, LONE])).body.data).toEqual({ items: [] })
    expect(stand.views).toEqual([])
  }),
)
