import { afterAll, expect } from "bun:test"
import { LLMClient, type LanguageModel } from "@opencode/ai/effect"
import { AnthropicCompatible, OpenAICompatibleResponses } from "@opencode/ai/providers"
import { Auth, RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerSummaries } from "@opencode/core/pacer/summaries"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

// Spec cliproxypacer-server-summaries, section 3: CLIProxyPacer writes a chat's summary through
// `POST /v1/responses/compact`, and openforge keeps it as its own; openforge writes it when it is to, or when
// CLIProxyPacer can't. A fake CLIProxyPacer on 127.0.0.1 answers in its shapes (`compaction_write.rs`, `dispatch.rs`)
// with synthetic data only; who writes is `PacerSummaries.plan`'s (its own tests), set here per test.

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

const key = "test-client-key"
const ownSummary = "## Objective\n- openforge's own summary"
const cppSummary = "The user planned a dark mode; the assistant gave the plan."
const fake = {
  seen: [] as Seen[],
  /** How CLIProxyPacer answers `/v1/responses/compact`. */
  compact: "readable" as "readable" | "capsule" | "501" | "500" | "hang",
  header: "warm; model=kimi-e2e; writer=server" as string | undefined,
  /** Resolves when a `/responses/compact` request arrives. */
  arrived: Promise.withResolvers<void>(),
}

const sse = (events: ReadonlyArray<readonly [string, unknown]>) =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url)
    const text = await request.text()
    fake.seen.push({
      method: request.method,
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    })
    if (url.pathname === "/v1/responses/compact") {
      fake.arrived.resolve()
      if (fake.compact === "hang") return new Promise<Response>(() => {})
      if (fake.compact === "501")
        return Response.json(
          {
            error: {
              message: "Remote compaction is not available for model kimi-e2e on provider kimi.",
              type: "invalid_request_error",
              param: null,
              code: "remote_compaction_unsupported",
            },
          },
          { status: 501 },
        )
      if (fake.compact === "500") return Response.json({ error: { message: "synthetic" } }, { status: 500 })
      const checkpoint = { type: "compaction", id: "cmp_cpa_compact_1", encrypted_content: "cpa-ag-compact-v1:stub" }
      const readable = {
        type: "message",
        role: "user",
        id: "msg_cpa_compact_1",
        status: "completed",
        content: [{ type: "input_text", text: `Context summary from previous turns:\n${cppSummary}` }],
      }
      return Response.json(
        {
          object: "response.compaction",
          status: "completed",
          id: "resp_cpa_compact_1",
          output: fake.compact === "capsule" ? [checkpoint] : [readable, checkpoint],
          usage: {
            input_tokens: 2_100,
            input_tokens_details: { cached_tokens: 2_048 },
            output_tokens: 90,
            total_tokens: 2_190,
          },
        },
        { headers: fake.header ? { "x-pacer-compaction": fake.header } : {} },
      )
    }
    if (url.pathname === "/v1/responses")
      return sse([
        ["response.output_item.added", { type: "response.output_item.added", item: { type: "message", id: "msg_1" } }],
        ["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", delta: ownSummary }],
        [
          "response.completed",
          { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 400, output_tokens: 20 } } },
        ],
      ])
    if (url.pathname === "/v1/messages")
      return sse([
        [
          "message_start",
          {
            type: "message_start",
            message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 400 } },
          },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ownSummary } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
        ["message_stop", { type: "message_stop" }],
      ])
    return Response.json({ error: { type: "not_found", message: "no route" } }, { status: 404 })
  },
})
afterAll(() => server.stop(true))
const baseURL = `http://127.0.0.1:${server.port}/v1`

const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(5),
    cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(1.25) },
  },
]
const resolved = (model: LanguageModel) =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost,
    limit: { context: 200_000, output: 32_000 },
  })
// CLIProxyPacer's models as the provider builds them: Claude speaks Messages, every other model Responses.
const responses = (id: string) =>
  OpenAICompatibleResponses.configure({ apiKey: key, baseURL, provider: "cliproxypacer" }).model(id)
const kimi = resolved(responses("kimi-e2e"))
const kimiMini = resolved(responses("kimi-e2e-mini"))
const claude = resolved(
  AnthropicCompatible.configure({ auth: Auth.bearer(key), baseURL, provider: "cliproxypacer" }).model("claude-e2e"),
)
const byID = new Map([kimi, kimiMini, claude].map((model) => [String(model.ref.id), model]))
const pacerRef = (id: string) =>
  Model.Ref.make({ id: Model.ID.make(id), providerID: Provider.ID.make("cliproxypacer") })

const plans: PacerSummaries.PlanInput[] = []
const decision: { current: PacerSummaries.Decision } = { current: { by: "cliproxypacer" } }

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(
        LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer)),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      PacerSummaries.node.replace(
        Layer.succeed(
          PacerSummaries.Service,
          PacerSummaries.Service.of({
            plan: (input) =>
              Effect.sync(() => {
                plans.push(input)
                return decision.current
              }),
          }),
        ),
      ),
      SessionRunnerModel.node.replace(
        Layer.mock(SessionRunnerModel.Service)({
          resolve: (session) => {
            const found = session.model && byID.get(String(session.model.id))
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new SessionRunnerModel.ModelUnavailableError({
                    providerID: session.model?.providerID ?? Provider.ID.make("none"),
                    modelID: session.model?.id ?? Model.ID.make("none"),
                  }),
                )
          },
        }),
      ),
    ],
  ),
)

const reset = (next: PacerSummaries.Decision = { by: "cliproxypacer" }) => {
  fake.seen.length = 0
  fake.compact = "readable"
  fake.header = "warm; model=kimi-e2e; writer=server"
  fake.arrived = Promise.withResolvers<void>()
  plans.length = 0
  decision.current = next
}

const insertSession = (id: Session.ID, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...(parentID ? { parent_id: parentID } : {}),
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const user = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })
const assistant = (text: string, model: SessionRunnerModel.Resolved) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: model.ref,
    content: [{ type: "text", text }],
    tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  })

/** A chat of two exchanges on `model`, stored as its history. */
const chat = Effect.fnUntraced(function* (name: string, model: SessionRunnerModel.Resolved) {
  const id = Session.ID.make(`ses_pacer_summary_${name}`)
  const parentID = Session.ID.make(`ses_pacer_summary_${name}_parent`)
  const session = yield* insertSession(id, parentID)
  const messages = [
    user("Plan a dark mode."),
    assistant("Here is a five-step plan.", model),
    user("Now list three risks."),
    assistant("Missed styles, contrast, preference behaviour.", model),
  ]
  const db = (yield* Database.Service).db
  yield* db
    .insert(SessionMessageTable)
    .values(
      messages.map((message, index) => {
        const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
        return { id: SessionMessage.ID.make(messageID), session_id: id, type, seq: index + 1, time_created: 0, data }
      }),
    )
    .run()
    .pipe(Effect.orDie)
  yield* Bus.reserveSequence(db, id, messages.length)
  return {
    session,
    messages,
    context: {
      session,
      messages,
      model,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
      tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
    },
  }
})

/** The chat's completed compaction, as stored. */
const record = Effect.fnUntraced(function* (sessionID: Session.ID) {
  const [first] = yield* (yield* SessionStore.Service).context(sessionID)
  if (first?.type !== "compaction" || first.status !== "completed") return yield* Effect.die("no completed compaction")
  return first
})

const compactions = () => fake.seen.filter((item) => item.path === "/v1/responses/compact")
const own = () => fake.seen.filter((item) => item.path === "/v1/responses" || item.path === "/v1/messages")

it.effect("a Responses chat: CLIProxyPacer writes it from the step's request, kept as openforge's own summary", () =>
  Effect.gen(function* () {
    reset()
    fake.header = "warm; model=kimi-e2e; writer=server; user_messages=2"
    const { session, messages, context } = yield* chat("responses", kimi)
    const compaction = yield* SessionCompaction.Service
    expect(
      yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
    ).toEqual({ status: "completed" })

    expect(plans).toEqual([
      { sessionID: session.id, parentID: session.parentID, model: "kimi-e2e", messages: false, warm: "view" },
    ])
    // The request on the wire: the summary's headers, the step's body in the Responses format.
    const [sent] = compactions()
    expect(compactions()).toHaveLength(1)
    expect(own()).toEqual([])
    expect(sent?.headers).toMatchObject({
      authorization: `Bearer ${key}`,
      "x-pacer-session": PacerSessionID.make(session.id),
      "x-pacer-parent-session": PacerSessionID.make(session.parentID!),
      "x-pacer-kind": "compaction",
    })
    expect(sent?.headers).not.toHaveProperty("x-pacer-compact")
    expect(sent?.body).toMatchObject({
      model: "kimi-e2e",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a dark mode." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is a five-step plan." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Now list three risks." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Missed styles, contrast, preference behaviour." }],
        },
      ],
    })
    expect(String(sent?.body.instructions)).toContain("Session instructions")
    expect(sent?.body).not.toHaveProperty("stream")

    // The record: CLIProxyPacer's summary without its prefix, who wrote it and on which model, the newest exchange kept.
    const stored = yield* record(session.id)
    expect(stored.summary).toBe(cppSummary)
    expect(stored.writer).toEqual({ by: "cliproxypacer", cold: false, userMessages: 2 })
    expect(stored.model).toEqual(pacerRef("kimi-e2e"))
    expect(stored.metadata?.keepID).toBe(messages[2]!.id)
    expect(stored.tokens).toMatchObject({ output: 90, cache: { read: 2_048 } })

    // The chat's next step opens with that summary.
    const db = (yield* Database.Service).db
    const history = yield* SessionHistory.load(db, session.id, kimi.ref)
    const next = JSON.stringify(toLLMMessages(history, kimi.ref)[0])
    expect(next).toContain(cppSummary)
    expect(next).not.toContain("Context summary from previous turns")
  }),
)

it.effect("a Messages chat CLIProxyPacer writes for gets its request rendered as Responses, at the same address", () =>
  Effect.gen(function* () {
    reset()
    fake.header = "cold; model=kimi-e2e-mini; writer=server"
    const { session, context } = yield* chat("messages", claude)
    const compaction = yield* SessionCompaction.Service
    expect(
      yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
    ).toEqual({ status: "completed" })
    expect(plans[0]).toMatchObject({ model: "claude-e2e", messages: true, warm: "view" })
    const [sent] = compactions()
    expect(own()).toEqual([])
    expect(sent?.headers.authorization).toBe(`Bearer ${key}`)
    expect(sent?.headers["x-pacer-kind"]).toBe("compaction")
    expect(sent?.body).toMatchObject({
      model: "claude-e2e",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a dark mode." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is a five-step plan." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Now list three risks." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Missed styles, contrast, preference behaviour." }],
        },
      ],
    })
    // Written on CLIProxyPacer's cheaper model for the cold chat, as its header says.
    const stored = yield* record(session.id)
    expect(stored.writer).toEqual({ by: "cliproxypacer", cold: true })
    expect(stored.model).toEqual(pacerRef("kimi-e2e-mini"))
  }),
)

it.effect("openforge writes when it is to: its own summary on the chat's route, the record saying so", () =>
  Effect.gen(function* () {
    for (const [name, model, path] of [
      ["own-responses", kimi, "/v1/responses"],
      ["own-messages", claude, "/v1/messages"],
    ] as const) {
      reset({ by: "openforge" })
      const { session, context } = yield* chat(name, model)
      const compaction = yield* SessionCompaction.Service
      expect(
        yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
      ).toEqual({ status: "completed" })
      expect(compactions()).toEqual([])
      expect(own().map((item) => item.path)).toEqual([path])
      const stored = yield* record(session.id)
      expect(stored.summary).toBe(ownSummary)
      expect(stored.writer).toEqual({ by: "openforge" })
      expect(stored.model).toEqual(model.ref)
    }
    // Where CLIProxyPacer can't write for the model's route, the record says why.
    reset({ by: "openforge", fallback: PacerSummaries.ROUTE })
    const { session, context } = yield* chat("own-route", kimi)
    yield* (yield* SessionCompaction.Service).compact({
      reason: "auto",
      context,
      estimate: { measured: 190_000, estimated: 0 },
    })
    expect(compactions()).toEqual([])
    expect((yield* record(session.id)).writer).toEqual({ by: "openforge", fallback: PacerSummaries.ROUTE })
  }),
)

it.effect("CLIProxyPacer couldn't: a 501, a failure, an answer without a readable summary; openforge writes it", () =>
  Effect.gen(function* () {
    for (const [compact, reason] of [
      ["501", "it answered 501"],
      ["500", "it answered 500"],
      ["capsule", "no readable summary"],
    ] as const) {
      reset()
      fake.compact = compact
      const { session, context } = yield* chat(`fallback-${compact}`, kimi)
      const compaction = yield* SessionCompaction.Service
      expect(
        yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
      ).toEqual({ status: "completed" })
      expect(compactions()).toHaveLength(1)
      expect(own().map((item) => item.path)).toEqual(["/v1/responses"])
      const stored = yield* record(session.id)
      expect(stored.summary).toBe(ownSummary)
      expect(stored.writer).toEqual({ by: "openforge", fallback: reason })
      expect(stored.model).toEqual(kimi.ref)
    }
  }),
)

it.effect("no answer within 4 minutes: openforge writes it", () =>
  Effect.gen(function* () {
    reset()
    fake.compact = "hang"
    const { session, context } = yield* chat("fallback-timeout", kimi)
    const compaction = yield* SessionCompaction.Service
    const fiber = yield* compaction
      .compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } })
      .pipe(Effect.forkChild)
    yield* Effect.promise(() => fake.arrived.promise)
    yield* TestClock.adjust("3 minutes")
    expect(own()).toEqual([])
    yield* TestClock.adjust("1 minute")
    expect(yield* Fiber.join(fiber)).toEqual({ status: "completed" })
    expect((yield* record(session.id)).writer).toEqual({ by: "openforge", fallback: "no answer in 4 minutes" })
  }),
)

it.effect("a move and a cold ask: warmth from the ask, CLIProxyPacer's first usable pick writes it", () =>
  Effect.gen(function* () {
    const ref = pacerRef
    const compaction = yield* SessionCompaction.Service
    // A move whose picks start with the chat's own model: warm, on that model.
    reset()
    const warm = yield* chat("move-warm", kimi)
    yield* compaction.compact({
      reason: "move",
      context: warm.context,
      models: [ref("kimi-e2e"), ref("kimi-e2e-mini")],
    })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e", warm: true })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e")
    // A move whose picks are the compaction models alone (the account ran out): cold, on the first usable one.
    reset()
    fake.header = "warm; model=kimi-e2e-mini; writer=server"
    const out = yield* chat("move-out", kimi)
    yield* compaction.compact({
      reason: "move",
      context: out.context,
      models: [ref("not-served"), ref("kimi-e2e-mini"), ref("kimi-e2e")],
    })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e-mini", warm: false })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e-mini")
    expect((yield* record(out.session.id)).model).toEqual(ref("kimi-e2e-mini"))
    // A cold ask: cold.
    reset()
    fake.header = "warm; model=kimi-e2e-mini; writer=server"
    const cold = yield* chat("cold-ask", claude)
    yield* compaction.compact({ reason: "cold", context: cold.context, models: [ref("kimi-e2e-mini")] })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e-mini", messages: true, warm: false })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e-mini")
    expect((yield* record(cold.session.id)).writer).toEqual({ by: "cliproxypacer", cold: false })
  }),
)

it.effect("a chat on another provider never asks CLIProxyPacer", () =>
  Effect.gen(function* () {
    reset()
    const other = resolved(
      OpenAICompatibleResponses.configure({ apiKey: key, baseURL, provider: "elsewhere" }).model("kimi-e2e"),
    )
    const { session, context } = yield* chat("elsewhere", other)
    yield* (yield* SessionCompaction.Service).compact({
      reason: "auto",
      context,
      estimate: { measured: 190_000, estimated: 0 },
    })
    expect(plans).toEqual([])
    expect(compactions()).toEqual([])
    expect((yield* record(session.id)).writer).toBeUndefined()
  }),
)
