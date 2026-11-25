import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { AnthropicMessages } from "@opencode/ai/protocols"
import { type LanguageModel } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Context, DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerEnv } from "@opencode/core/pacer/env"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import type { Tool } from "@opencode/core/tool"
import { gitVcs, location } from "../fixture/location"
import { noAncestors } from "../fixture/pacer-project"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { catalogOf, endpointOf, fakeCpp, startTools } from "./fake-tools"

// The set of a chat's .env values on its model requests to CLIProxyPacer (workspace spec `docs/specs/env-redaction.md`,
// section 3): every request names it by its digest, a refusal for an unknown set hands it over and sends the request
// once more, and no request goes without it once CPP asked for it.

const it = testEffect(PluginTestLayer)

const KEY = "client-key-test"
/** A value under a name that does not look secret, which only an exact value hides. */
const HEX = "0123456789abcdef0123456789abcdef01234567"
const OTHER = "fedcba9876543210fedcba9876543210fedcba98"

const withEnv = (catalog: PacerModels.Catalog): PacerModels.Catalog =>
  catalog.pacer ? { ...catalog, pacer: { ...catalog.pacer, redaction: { env: true } } } : catalog
/** CPP with the capability, as its capabilities answer would make the catalog. */
const capable = withEnv(catalogOf(true))

const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const resolved = (model: string | LanguageModel) =>
  SessionRunnerModel.resolved(
    typeof model === "string"
      ? AnthropicMessages.route.with({ provider: "cliproxypacer" }).model({ id: model })
      : model,
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
    },
  )

/** Tools whose one call runs `run`. */
const tools = (run: () => Promise<void> = async () => {}): Tool.Snapshot => ({
  definitions: [],
  execute: () => Effect.promise(run).pipe(Effect.as({ content: [{ type: "text" as const, text: "written" }] })),
})

const write = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(files).map(async ([name, text]) => {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
        await fs.writeFile(path.join(root, name), text)
      }),
    ),
  )

/** CPP's refusal of a request whose set it does not hold. */
const unknownSet = () =>
  Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "env_values_unknown",
        message: "CLIProxyPacer holds no .env values under this digest",
      },
    },
    { status: 428 },
  )
const answered = () => new Response('{"id":"msg_1"}', { headers: { "content-type": "application/json" } })

/**
 * SessionModelRequest for a chat whose folder is `files`' root, a git checkout unless `outside`, with PacerEnv over
 * a stand-in CPP: its catalog, and its refusals and answers in the test's hands.
 */
const setup = Effect.fnUntraced(function* (
  options: {
    readonly files?: Readonly<Record<string, string>>
    /** The catalog as read; undefined while none has been read. */
    readonly catalog?: PacerModels.Catalog | undefined
    readonly outside?: boolean
    /** The project a helper's lead gives it, from the lead's repository. */
    readonly lead?: PacerProject.Chat
    readonly parentID?: Session.ID
  } = {},
) {
  const root = (yield* tmpdirScoped()).path
  yield* write(root, options.files ?? { ".env": `BUILD_REF=${HEX}\n` })
  const cpp = yield* fakeCpp
  const catalog = "catalog" in options ? options.catalog : capable
  const started = yield* startTools(endpointOf(cpp.origin, KEY), catalog)
  if (catalog === undefined) yield* SubscriptionRef.set(started.catalogs, undefined)
  const endpointLayer = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({
      get: () => SubscriptionRef.get(started.endpoints),
      changes: () => SubscriptionRef.changes(started.endpoints),
    }),
  )
  const env = Context.get(
    yield* Layer.build(
      Layer.fresh(PacerEnv.layer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer)),
            endpointLayer,
            Layer.succeed(
              PacerModels.Service,
              PacerModels.Service.of({
                get: () => SubscriptionRef.get(started.catalogs),
                changes: () => SubscriptionRef.changes(started.catalogs),
                refresh: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
    ),
    PacerEnv.Service,
  )
  const ref = Location.Ref.make({ directory: AbsolutePath.make(root) })
  const projects = Layer.fresh(PacerProject.layer).pipe(
    Layer.provide(
      Layer.succeed(Location.Service, Location.Service.of(location(ref, options.outside ? {} : { vcs: gitVcs(root) }))),
    ),
    Layer.provide(Config.testLayer()),
    Layer.provide(
      options.lead
        ? Layer.succeed(
            PacerProject.Ancestors,
            PacerProject.Ancestors.of({ nearest: () => Effect.succeed(options.lead) }),
          )
        : noAncestors,
    ),
  )
  const requests = yield* SessionModelRequest.Service.pipe(
    Effect.provide(SessionModelRequest.layer),
    Effect.provideService(SessionModelTransport.Service, transport),
    Effect.provideService(PacerTools.Service, started.tools),
    Effect.provideService(PacerEnv.Service, env),
    Effect.provide(projects),
  )
  const session = Session.Info.make({
    id: Session.ID.make("ses_env_request"),
    ...(options.parentID ? { parentID: options.parentID } : {}),
    // A project of its own in git; outside git, none.
    projectID: Project.ID.make("env-request-project"),
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: ref,
  })
  const input = (snapshot: Tool.Snapshot = tools(), model: string | LanguageModel = "claude-haiku-5-5") => ({
    session,
    agent: Agent.ID.make("build"),
    model: resolved(model),
    tools: snapshot,
    system: [],
    messages: [],
  })
  /** What reached the wire, and the answers it gets in turn (the last one again once they run out). */
  const wire = (...answers: Array<() => Response>) => {
    const sent: HttpClientRequest.HttpClientRequest[] = []
    const handler = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        sent.push(request)
        return HttpClientResponse.fromWeb(request, answers[Math.min(sent.length, answers.length) - 1]!())
      })
    return { sent, handler }
  }
  /** One model request of `prepared` through its HTTP middleware, onto `onto`. */
  const send = (prepared: SessionModelRequest.Prepared<unknown>, onto: ReturnType<typeof wire>) =>
    prepared.options.http!(
      HttpClientRequest.post(`${cpp.origin}/v1/messages`).pipe(
        HttpClientRequest.bodyText('{"model":"claude-haiku-5-5"}', "application/json"),
      ),
      onto.handler,
    )
  return { root, cpp, requests, input, wire, send, catalogs: started.catalogs, session }
})

const header = (request: HttpClientRequest.HttpClientRequest | undefined) => request?.headers["x-pacer-env"]
const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined) =>
  request?.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
const errorOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((body) => (body as { error: { message: string } }).error.message))

describe("a chat's .env values on its model requests to CLIProxyPacer", () => {
  it.live("names the set on every model request: steps, titles, one-off generations and summaries", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const digest = PacerEnv.digest(KEY, [HEX])
      for (const kind of ["primary", "title", "generate", "compaction"] as const) {
        const onto = h.wire(answered)
        const response = yield* h.send(yield* h.requests[kind](h.input()), onto)
        expect([kind, response.status, onto.sent.length, header(onto.sent[0])]).toEqual([kind, 200, 1, digest])
      }
      // CPP held the set: nothing was handed over.
      expect(h.cpp.envs()).toHaveLength(0)
    }),
  )

  it.live("hands CPP the set when it refuses an unknown one, and sends the same request once more", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const digest = PacerEnv.digest(KEY, [HEX])
      const onto = h.wire(unknownSet, answered)
      const response = yield* h.send(yield* h.requests.primary(h.input()), onto)
      expect(response.status).toBe(200)
      expect(onto.sent.map(header)).toEqual([digest, digest])
      expect(onto.sent.map(bodyOf)).toEqual(['{"model":"claude-haiku-5-5"}', '{"model":"claude-haiku-5-5"}'])
      const put = h.cpp.envs()
      expect(put).toHaveLength(1)
      expect(put[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
      expect(JSON.parse(put[0]!.body)).toEqual({ digest, values: [HEX] })
    }),
  )

  it.live("fails with a plain error when CPP refuses again, never sending the request without the set", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const onto = h.wire(unknownSet)
      const response = yield* h.send(yield* h.requests.primary(h.input()), onto)
      expect(onto.sent.map(header)).toEqual([PacerEnv.digest(KEY, [HEX]), PacerEnv.digest(KEY, [HEX])])
      expect(h.cpp.envs()).toHaveLength(1)
      expect(response.status).toBe(428)
      expect(yield* errorOf(response)).toBe(
        "CLIProxyPacer refused this request again after openforge sent it the chat's .env values; it was not sent without them.",
      )
    }),
  )

  it.live("fails without sending the request again when CPP does not take the set", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      h.cpp.answers.env = () =>
        Response.json(
          { error: { type: "invalid_request_error", message: "the digest does not match the values" } },
          { status: 400 },
        )
      const onto = h.wire(unknownSet, answered)
      const response = yield* h.send(yield* h.requests.primary(h.input()), onto)
      expect(onto.sent).toHaveLength(1)
      expect(response.status).toBe(428)
      expect(yield* errorOf(response)).toBe(
        "CLIProxyPacer did not take the chat's .env values, so the request was not sent without them: the digest does not match the values",
      )

      // An unreachable CPP is an answer the step's retry waits out, as any 503 of CPP's.
      h.cpp.answers.env = () => Response.json({ error: { type: "cpp_down", message: "CPP is down" } }, { status: 503 })
      const down = yield* h.send(yield* h.requests.primary(h.input()), h.wire(unknownSet, answered))
      expect(down.status).toBe(503)
    }),
  )

  it.live("sends neither the header nor the set to a CLIProxyPacer without the capability", () =>
    Effect.gen(function* () {
      const h = yield* setup({ catalog: catalogOf(true) })
      const onto = h.wire(unknownSet)
      const response = yield* h.send(yield* h.requests.primary(h.input()), onto)
      expect(onto.sent.map(header)).toEqual([undefined])
      // Its answer passes as it came.
      expect(response.status).toBe(428)
      expect(yield* errorOf(response)).toBe("CLIProxyPacer holds no .env values under this digest")
      expect(h.cpp.envs()).toHaveLength(0)

      // A plain proxy, neither.
      yield* SubscriptionRef.set(h.catalogs, catalogOf("no pacer"))
      const plain = h.wire(answered)
      yield* h.send(yield* h.requests.primary(h.input()), plain)
      expect(plain.sent.map(header)).toEqual([undefined])
    }),
  )

  it.live("names the set while no catalog has been read, as after a restart", () =>
    Effect.gen(function* () {
      const h = yield* setup({ catalog: undefined })
      const onto = h.wire(unknownSet, answered)
      expect((yield* h.send(yield* h.requests.primary(h.input()), onto)).status).toBe(200)
      expect(onto.sent.map(header)).toEqual([PacerEnv.digest(KEY, [HEX]), PacerEnv.digest(KEY, [HEX])])
    }),
  )

  it.live("sends no header for another provider's model, nor for a repository without a .env value", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const other = AnthropicMessages.route.with({ provider: "anthropic" }).model({ id: "claude-sonnet-5" })
      const onto = h.wire(answered)
      yield* h.send(yield* h.requests.primary(h.input(tools(), other)), onto)
      expect(onto.sent.map(header)).toEqual([undefined])

      const empty = yield* setup({ files: { ".env": "SHORT=short\n", ".env.example": `EXAMPLE=${HEX}\n` } })
      const none = empty.wire(unknownSet)
      expect((yield* empty.send(yield* empty.requests.primary(empty.input()), none)).status).toBe(428)
      expect(none.sent.map(header)).toEqual([undefined])
      expect(empty.cpp.envs()).toHaveLength(0)
    }),
  )

  it.live("puts a .env file a tool writes in the set of the very next request", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const step = yield* h.requests.primary(
        h.input(
          tools(async () => {
            await fs.mkdir(path.join(h.root, "packages/fresh"), { recursive: true })
            await fs.writeFile(path.join(h.root, "packages/fresh/.env"), `FRESH_REF=${OTHER}\n`)
          }),
        ),
      )
      yield* h.send(step, h.wire(answered))
      yield* step.executeTool({
        sessionID: h.session.id,
        agent: Agent.ID.make("build"),
        messageID: "msg_env_request" as never,
        call: {
          type: "tool-call",
          id: "call_1",
          name: "write",
          input: { filePath: path.join(h.root, "packages/fresh/.env"), content: `FRESH_REF=${OTHER}\n` },
        },
      })
      const next = h.wire(unknownSet, answered)
      yield* h.send(yield* h.requests.primary(h.input()), next)
      const digest = PacerEnv.digest(KEY, PacerEnv.sorted([HEX, OTHER]))
      expect(next.sent.map(header)).toEqual([digest, digest])
      expect(JSON.parse(h.cpp.envs()[0]!.body)).toEqual({ digest, values: PacerEnv.sorted([HEX, OTHER]) })
    }),
  )

  it.live("sends a helper outside git its lead's repository's set, and a chat in no project its own folder's", () =>
    Effect.gen(function* () {
      const lead = (yield* tmpdirScoped()).path
      yield* write(lead, { ".env": `LEAD_REF=${OTHER}\n` })
      const helper = yield* setup({
        outside: true,
        files: { ".env": `HELPER_REF=${HEX}\n` },
        parentID: Session.ID.make("ses_env_request_lead"),
        lead: { project: "lead-project", headers: { "X-Pacer-Project": "lead-project" }, repository: lead },
      })
      const onto = helper.wire(answered)
      yield* helper.send(yield* helper.requests.primary(helper.input()), onto)
      expect(onto.sent.map(header)).toEqual([PacerEnv.digest(KEY, [OTHER])])

      const alone = yield* setup({
        outside: true,
        files: { ".env": `OWN_REF=${HEX}\n`, "child/.env": `CHILD_REF=${OTHER}\n` },
      })
      const own = alone.wire(answered)
      yield* alone.send(yield* alone.requests.primary(alone.input()), own)
      expect(own.sent.map(header)).toEqual([PacerEnv.digest(KEY, [HEX])])
    }),
  )
})
