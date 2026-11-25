import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerIdentity } from "@opencode/core/pacer/identity"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { SessionID } from "@opencode/schema/session-id"
import { catalogOf } from "../memory/fixture"
import { testEffect } from "../lib/effect"

// The service's side of the owner's /identity (the workspace's spec docs/specs/agent-badges.md, section 1, item 6;
// reference docs/reference/agent-identity-api.md): offered only while CPP's capabilities say identities, the chat's
// project's identities read with the chat's headers, and a link sent as an identity event on the chat's events, CPP's
// refusals in words for the person.

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

/** A stand-in CPP that records each request and answers with `answer`. */
const serve = (answer: (seen: Seen) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url)
          const text = request.method === "POST" ? await request.text() : ""
          const one = {
            method: request.method,
            path: url.pathname + url.search,
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

const service = (origin: string | undefined, catalog: PacerModels.Catalog | undefined) => {
  const current = origin
    ? PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: "identity-test-key" }, undefined)
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
  return PacerIdentity.layer.pipe(
    Layer.provide(PacerHttp.layer.pipe(Layer.provide(endpoints), Layer.provide(FetchHttpClient.layer))),
    Layer.provide([endpoints, models]),
  )
}

const using = <A, E>(
  layer: ReturnType<typeof service>,
  use: (identity: PacerIdentity.Interface) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* PacerIdentity.Service)
  }).pipe(Effect.provide(layer))

const CHAT = SessionID.make("ses_identity_chat")
const OTHER = SessionID.make("ses_identity_other")
const chat: PacerIdentity.Chat = {
  sessionID: CHAT,
  agent: "build",
  project: "github.com/floris/theorysnap",
  headers: { "X-Pacer-Project": "github.com/floris/theorysnap", "X-Pacer-Project-Vcs": "git" },
}

/** An identity as CPP answers it. */
const wire = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "floris's lead",
  person: "floris",
  part: "lead",
  role: "build",
  title: "Agent badges plan",
  parent: null,
  chats: [
    {
      session: PacerSessionID.make(CHAT),
      chat: CHAT,
      key_id: 2,
      since: 1_764_064_000_000,
      how: "made",
      current: true,
    },
  ],
  open_tasks: [{ id: "0cqc3r7s96ff", parent: null, title: "Build agent identity", state: "active" }],
  made_at: 1_764_064_000_000,
  last_active: null,
  ...extra,
})

const offering = catalogOf(true, { identities: true })
const it = testEffect(Layer.empty)

describe("PacerIdentity", () => {
  it.live("offers identities only while CPP's capabilities say so", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => Response.json({ identities: [] }))
      for (const [catalog, offered] of [
        [offering, true],
        [catalogOf(true), false],
        [catalogOf("no pacer"), false],
        [undefined, false],
      ] as const) {
        const layer = service(cpp.origin, catalog)
        expect(yield* using(layer, (identity) => identity.features())).toEqual({ identities: offered })
        if (offered) continue
        // Without them nothing is asked of CPP.
        const listed = yield* using(layer, (identity) => identity.list(chat).pipe(Effect.flip))
        expect(listed).toEqual(new PacerIdentity.Refused({ reason: PacerIdentity.NOT_OFFERED }))
        const linked = yield* using(layer, (identity) => identity.link(chat, { new: true }).pipe(Effect.flip))
        expect(linked).toEqual(new PacerIdentity.Refused({ reason: PacerIdentity.NOT_OFFERED }))
      }
      expect(cpp.seen).toEqual([])
    }),
  )

  it.live("reads the chat's project's identities with the chat's headers, and finds the one it is now", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() =>
        Response.json({
          identities: [
            wire("k3m9x2v7p0qa", { last_active: 1_764_068_000_000 }),
            wire("a1b2c3d4e5f6", {
              name: "lead (owner unknown)",
              person: null,
              title: null,
              chats: [
                {
                  session: PacerSessionID.make(OTHER),
                  chat: OTHER,
                  key_id: 2,
                  since: 1,
                  how: "made",
                  current: true,
                },
              ],
              open_tasks: [],
            }),
          ],
          more: false,
        }),
      )
      const listed = yield* using(service(cpp.origin, offering), (identity) => identity.list(chat))
      expect(listed.current).toBe("k3m9x2v7p0qa")
      expect(listed.items.map((item) => item.id)).toEqual(["k3m9x2v7p0qa", "a1b2c3d4e5f6"])
      expect(listed.items[0]).toMatchObject({
        name: "floris's lead",
        person: "floris",
        part: "lead",
        role: "build",
        title: "Agent badges plan",
        chats: [{ chat: CHAT, how: "made", current: true }],
        openTasks: [{ id: "0cqc3r7s96ff", title: "Build agent identity", state: "active" }],
      })
      expect(listed.items[1]).not.toHaveProperty("person")
      expect(listed.items[1]).not.toHaveProperty("title")
      expect(listed.items[1]).not.toHaveProperty("lastActive")
      const [asked] = cpp.seen
      expect(asked).toMatchObject({
        method: "GET",
        path: "/pacer/v1/projects/github.com%2Ffloris%2Ftheorysnap/identities",
        headers: {
          authorization: "Bearer identity-test-key",
          "x-pacer-session": PacerSessionID.make(CHAT),
          "x-pacer-chat": CHAT,
          "x-pacer-agent": "build",
          "x-pacer-project": "github.com/floris/theorysnap",
          "x-pacer-project-vcs": "git",
        },
      })
      // A chat that is none of them is none.
      const none = yield* using(service(cpp.origin, offering), (identity) =>
        identity.list({ ...chat, sessionID: SessionID.make("ses_identity_new") }),
      )
      expect(none).not.toHaveProperty("current")
    }),
  )

  it.live("sends a link as an identity event on the chat's events: an identity, a session, or new", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() =>
        Response.json({ id: "x", type: "identity", identity: wire("k3m9x2v7p0qa"), changed: true }),
      )
      const linked = yield* using(service(cpp.origin, offering), (identity) =>
        Effect.all([
          identity.link(chat, { identity: "k3m9x2v7p0qa" }),
          identity.link(chat, { session: OTHER }),
          identity.link(chat, { session: "0B6D1C52-5E0A-4F8E-9A51-2C4B7F1D9E30" }),
          identity.link(chat, { new: true }),
        ]),
      )
      expect(linked[0]).toMatchObject({ identity: { id: "k3m9x2v7p0qa", name: "floris's lead" }, changed: true })
      expect(cpp.seen.map((seen) => [seen.method, seen.path])).toEqual(
        Array.from({ length: 4 }, () => ["POST", `/pacer/v1/sessions/${PacerSessionID.make(CHAT)}/events`]),
      )
      expect(cpp.seen.map((seen) => seen.body)).toEqual([
        { type: "identity", identity: "k3m9x2v7p0qa" },
        // openforge's session ID goes as the UUID CPP knows the chat by; a UUID as it is.
        { type: "identity", session: PacerSessionID.make(OTHER) },
        { type: "identity", session: "0b6d1c52-5e0a-4f8e-9a51-2c4b7f1d9e30" },
        { type: "identity", new: true },
      ])
      expect(cpp.seen[0]?.headers).toMatchObject({
        "x-pacer-project": "github.com/floris/theorysnap",
        "x-pacer-agent": "build",
        "x-pacer-chat": CHAT,
      })
      // One target, never none or two.
      for (const wrong of [{}, { identity: "k3m9x2v7p0qa", new: true }, { identity: " ", session: "" }])
        expect(
          yield* using(service(cpp.origin, offering), (identity) => identity.link(chat, wrong).pipe(Effect.flip)),
        ).toEqual(new PacerIdentity.Refused({ reason: PacerIdentity.ONE_TARGET }))
      expect(cpp.seen.length).toBe(4)
    }),
  )

  it.live("says CPP's refusals in words for the person, and when CPP can't be asked", () =>
    Effect.gen(function* () {
      const refusal = (status: number, type: string, message: string) =>
        Response.json({ error: { type, message } }, { status })
      const answers = [
        refusal(
          404,
          "unknown_session",
          "no chat 0b6d1c52 with an identity in this project: it has to have acted on the board first",
        ),
        refusal(
          409,
          "another_project",
          "that identity is another project's: a chat takes only an identity of its own project",
        ),
        refusal(404, "project_memory_off", "memory is off"),
        refusal(403, "project_forbidden", "closed"),
        new Response("bad gateway", { status: 502 }),
      ]
      const cpp = yield* serve(() => answers.shift()!)
      const layer = service(cpp.origin, offering)
      const failed = []
      for (let i = 0; i < 5; i++)
        failed.push(yield* using(layer, (identity) => identity.link(chat, { session: OTHER }).pipe(Effect.flip)))
      expect(failed.map((error) => [error._tag, error.message])).toEqual([
        [
          "PacerIdentity.Refused",
          "No chat 0b6d1c52 with an identity in this project: it has to have acted on the board first.",
        ],
        [
          "PacerIdentity.Refused",
          "That identity is another project's: a chat takes only an identity of its own project.",
        ],
        ["PacerIdentity.Refused", "Memory is off for this chat's project, so it has no agents' identities."],
        ["PacerIdentity.Refused", "This key may not use this project's memory, nor its agents' identities."],
        ["PacerIdentity.Unavailable", "CLIProxyPacer can't be asked now: CLIProxyPacer is unreachable: HTTP 502"],
      ])
      const unset = yield* using(service(undefined, offering), (identity) => identity.list(chat).pipe(Effect.flip))
      expect(unset._tag).toBe("PacerIdentity.Unavailable")
    }),
  )
})
