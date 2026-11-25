import { expect } from "bun:test"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerIdentity } from "@opencode/core/pacer/identity"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { initRepo } from "../../core/test/fixture/git"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { catalogOf } from "../../core/test/memory/fixture"
import { ServerFetch } from "../src/fetch"

// The service's routes of the owner's /identity (the workspace's spec docs/specs/agent-badges.md, section 1, item 6;
// reference docs/reference/agent-identity-api.md) against a stand-in CLIProxyPacer that records what it gets: the
// features the TUI follows, the chat's project's identities read with the headers of the chat's own location, a link
// sent as an identity event, and the refusals in words.

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

const KEY = "identity-test-key-0001"

/** A stand-in CPP: answers `answer`, and keeps what reached it. */
const cpp = (answer: (seen: Seen) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url)
          // The connection's own reads (state, capabilities, the stream) find nothing here.
          if (!url.pathname.endsWith("/identities") && !url.pathname.endsWith("/events"))
            return Response.json({ error: { type: "not_found" } }, { status: 404 })
          const text = request.method === "POST" ? await request.text() : ""
          const one = {
            method: request.method,
            path: url.pathname,
            headers: Object.fromEntries(request.headers),
            ...(text ? { body: JSON.parse(text) } : {}),
          }
          seen.push(one)
          return answer(one)
        },
      })
      return { seen, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

/** The service in process, CPP at `origin` saying `identities` in its capabilities or not. */
const service = Effect.fnUntraced(function* (origin: string, identities: boolean) {
  const endpoint = PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: KEY }, undefined)
  const catalog = catalogOf(true, { identities })
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
  const call = (method: string, path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
      )
      return { status: response.status, body: await response.json() }
    })
  /** A chat at `directory`; its ID. */
  const session = (directory: string) =>
    Effect.map(call("POST", "/api/session", { title: "Identity", location: { directory } }), (made) => {
      expect(made.status).toBe(200)
      return made.body.data.id as string
    })
  return { call, session }
})

/** An identity as CPP answers it, made by chat `session` (its CPP UUID) of openforge chat `chat`. */
const wire = (id: string, session: string, chat: string) => ({
  id,
  name: "floris's lead",
  person: "floris",
  part: "lead",
  role: "build",
  title: "Agent badges plan",
  parent: null,
  chats: [{ session, chat, key_id: 2, since: 1_764_064_000_000, how: "made", current: true }],
  open_tasks: [],
  made_at: 1_764_064_000_000,
  last_active: 1_764_068_000_000,
})

it.live("reads a chat's project's identities and links it with the headers of the chat's own location", () =>
  Effect.gen(function* () {
    const repo = (yield* tmpdirScoped("opencode-identity-repo-")).path
    yield* Effect.promise(() => initRepo(repo))
    const chats: string[] = []
    const stand = yield* cpp((seen) =>
      seen.method === "GET"
        ? Response.json({
            identities: [wire("k3m9x2v7p0qa", PacerSessionID.make(chats[0] as never), chats[0]!)],
            more: false,
          })
        : Response.json({
            id: "x",
            type: "identity",
            identity: wire("k3m9x2v7p0qa", PacerSessionID.make(chats[1] as never), chats[1]!),
            changed: true,
          }),
    )
    const svc = yield* service(stand.origin, true)
    expect(yield* svc.call("GET", "/api/experimental/pacer/features")).toEqual({
      status: 200,
      body: { data: { identities: true } },
    })
    chats.push(yield* svc.session(repo), yield* svc.session(repo))
    const listed = yield* svc.call("GET", `/api/experimental/pacer/chat/${chats[0]}/identities`)
    expect(listed.status).toBe(200)
    expect(listed.body.data).toMatchObject({
      current: "k3m9x2v7p0qa",
      items: [{ id: "k3m9x2v7p0qa", name: "floris's lead", title: "Agent badges plan", chats: [{ chat: chats[0] }] }],
    })
    const linked = yield* svc.call("POST", `/api/experimental/pacer/chat/${chats[1]}/identity`, { session: chats[0] })
    expect(linked).toMatchObject({ status: 200, body: { data: { identity: { id: "k3m9x2v7p0qa" }, changed: true } } })
    const [read, link] = stand.seen
    const project = read?.headers["x-pacer-project"]
    expect(project).toBeTruthy()
    expect(read).toMatchObject({
      method: "GET",
      path: `/pacer/v1/projects/${encodeURIComponent(project!)}/identities`,
      headers: {
        authorization: `Bearer ${KEY}`,
        "x-pacer-session": PacerSessionID.make(chats[0] as never),
        "x-pacer-chat": chats[0],
        "x-pacer-agent": "build",
        "x-pacer-project-vcs": "git",
      },
    })
    expect(link).toMatchObject({
      method: "POST",
      path: `/pacer/v1/sessions/${PacerSessionID.make(chats[1] as never)}/events`,
      headers: { "x-pacer-project": project, "x-pacer-chat": chats[1] },
      body: { type: "identity", session: PacerSessionID.make(chats[0] as never) },
    })
  }).pipe(Effect.scoped),
)

it.live("refuses in words: a chat outside git, CPP's refusal, a CPP without identities", () =>
  Effect.gen(function* () {
    const repo = (yield* tmpdirScoped("opencode-identity-repo-")).path
    yield* Effect.promise(() => initRepo(repo))
    const plain = (yield* tmpdirScoped("opencode-identity-plain-")).path
    const stand = yield* cpp(() =>
      Response.json(
        { error: { type: "unknown_session", message: "no chat 0b6d1c52 with an identity in this project" } },
        { status: 404 },
      ),
    )
    const svc = yield* service(stand.origin, true)
    const outside = yield* svc.call("GET", `/api/experimental/pacer/chat/${yield* svc.session(plain)}/identities`)
    expect(outside).toMatchObject({ status: 400, body: { message: PacerProject.OUTSIDE_GIT } })
    expect(stand.seen).toEqual([])
    const chat = yield* svc.session(repo)
    const unknown = yield* svc.call("POST", `/api/experimental/pacer/chat/${chat}/identity`, {
      session: "0b6d1c52-5e0a-4f8e-9a51-2c4b7f1d9e30",
    })
    expect(unknown).toMatchObject({
      status: 400,
      body: { message: "No chat 0b6d1c52 with an identity in this project." },
    })
    const older = yield* service(stand.origin, false)
    expect((yield* older.call("GET", "/api/experimental/pacer/features")).body).toEqual({ data: { identities: false } })
    const refused = yield* older.call("GET", `/api/experimental/pacer/chat/${yield* older.session(repo)}/identities`)
    expect(refused).toMatchObject({ status: 400, body: { message: PacerIdentity.NOT_OFFERED } })
    expect(stand.seen).toHaveLength(1)
  }).pipe(Effect.scoped),
)
