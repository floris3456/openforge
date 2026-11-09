import { afterAll, expect } from "bun:test"
import { ai, CacheHint, LLMClient, type LanguageModel, Message, ToolDefinition } from "@opencode/ai/effect"
import { AnthropicCompatible, OpenAICompatibleResponses } from "@opencode/ai/providers"
import { Auth, RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerStatus } from "@opencode/core/pacer/status"
import { PacerSummaries } from "@opencode/core/pacer/summaries"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import type { SessionContext } from "@opencode/core/session/context"
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
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

// Spec cliproxypacer-server-summaries, section 3: CLIProxyPacer writes a chat's summary through
// `POST /v1/responses/compact`, a Claude chat's too, and openforge keeps it as its own; openforge writes it when it is
// to, or when CLIProxyPacer can't, as an ordinary request of the chat with `X-Pacer-Kind: compaction`. A fake
// CLIProxyPacer on 127.0.0.1 answers in its shapes (`compaction_write.rs`, `dispatch.rs`) with synthetic data only; who
// writes is `PacerSummaries.plan`'s (its own tests), set here per test, or the real one (`planned`).

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
  /**
   * `compaction.user_messages` on: the readable answer lists the user messages of the history it was sent after the
   * summary, numbered, as CLIProxyPacer does (`compaction_users.rs`).
   */
  users: false,
  /** Resolves when a `/responses/compact` request arrives. */
  arrived: Promise.withResolvers<void>(),
  /**
   * CLIProxyPacer's view of each chat, by its ID there, each with its own settings, for the real
   * `PacerSummaries.plan`; a chat without one is unknown to it (404). The key and server levels hold no writer.
   */
  views: new Map<string, Record<string, unknown>>(),
}

/** The user messages' texts in a Responses body's input. */
const userTexts = (body: Record<string, unknown>) =>
  (Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [])
    .filter((item) => item.role === "user")
    .map((item) =>
      (Array.isArray(item.content) ? (item.content as Array<{ text?: unknown }>) : [])
        .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
        .join(""),
    )

/**
 * The usage of a summary CLIProxyPacer writes, in its shape since 2026-11-08 (CLIENT-GUIDE 4.2, "The usage of a summary
 * the server writes", head 272baab4): `input_tokens` counts all input, reads and writes among it; the writes are
 * `cache_write_tokens` (by lifetime in `cache_creation`); `output_tokens` counts all output, its thinking in
 * `reasoning_tokens`. Before, the writes stayed inside `input_tokens` with no field of their own, so a summary that
 * wrote the cache was priced low (`run/evidence/cpp-summaries/live-warm-claude/`: 13 %).
 */
const compactUsage = {
  input_tokens: 2_100,
  input_tokens_details: {
    cached_tokens: 1_800,
    cache_write_tokens: 296,
    cache_creation: { ephemeral_5m_input_tokens: 296, ephemeral_1h_input_tokens: 0 },
  },
  output_tokens: 90,
  output_tokens_details: { reasoning_tokens: 30 },
  total_tokens: 2_190,
}
/**
 * How openforge records `compactUsage` at the catalog's prices below: 4 plain input × $1 + 90 output × $5 + 1,800 reads
 * × $0.10 + 296 writes × $1.25, per million tokens. Read without its writes, it would be 300 input and $0.000930.
 */
const compactRecorded = {
  tokens: { input: 4, output: 60, reasoning: 30, cache: { read: 1_800, write: 296 } },
  cost: 0.001004,
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
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    fake.seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers), body })
    // A PATCH writes the chat's own settings and answers its view; a view says how they apply (pacer_sessions.rs).
    const chatID = url.pathname.match(/^\/pacer\/v1\/sessions\/([^/]+)$/)?.[1]
    if (chatID) {
      const held = fake.views.get(chatID)
      const view =
        request.method === "PATCH"
          ? { ...(held ?? { id: chatID }), settings: { ...(held?.settings as object | undefined), ...body } }
          : held
      if (view === undefined)
        return Response.json({ error: { type: "not_found", message: "no such session" } }, { status: 404 })
      fake.views.set(chatID, view)
      const own = (view.settings as Record<string, unknown> | undefined)?.["compaction.writer"]
      return Response.json({ ...view, effective: { compaction_writer: own ?? null } })
    }
    if (url.pathname === "/pacer/v1/settings")
      return Response.json([{ name: "compaction.writer", default: null, server: null, key: null, value: null }])
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
      const users = fake.users
        ? `\n\n<earlier-user-messages>\n${userTexts(body)
            .map((text, index) => `<message n="${index + 1}">${text}</message>`)
            .join("\n")}\n</earlier-user-messages>`
        : ""
      const readable = {
        type: "message",
        role: "user",
        id: "msg_cpa_compact_1",
        status: "completed",
        content: [{ type: "input_text", text: `Context summary from previous turns:\n${cppSummary}${users}` }],
      }
      return Response.json(
        {
          object: "response.compaction",
          status: "completed",
          id: "resp_cpa_compact_1",
          output: fake.compact === "capsule" ? [checkpoint] : [readable, checkpoint],
          usage: compactUsage,
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
const decision: { current: PacerSummaries.Decision | undefined } = { current: { by: "cliproxypacer" } }

const nodes = [
  Database.node,
  Bus.node,
  SessionProjector.node,
  SessionStore.node,
  SessionCompaction.node,
  SessionModelRequest.node,
  PluginHooks.node,
  llmClient,
] as const
const replacements = [
  Bus.node.replace(Bus.configured({ persist: true })),
  llmClient.replace(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
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
]

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([...nodes]), [
    ...replacements,
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
  ]),
)

/**
 * The same with the real `PacerSummaries.plan`, which asks the fake CLIProxyPacer for the chat's view and the key
 * level, and finds its models in this catalog: CLIProxyPacer writes for Claude and Kimi with `server`.
 */
const planned = testEffect(
  AppNodeBuilder.build(LayerNode.group([...nodes, PacerStatus.node]), [
    ...replacements,
    PacerEndpoint.node.replace(
      Layer.succeed(
        PacerEndpoint.Service,
        PacerEndpoint.Service.of({
          get: () => Effect.succeed(PacerEndpoint.resolve({ baseURL, apiKey: key }, undefined)),
          changes: () => Effect.die("unused") as never,
        }),
      ),
    ),
    PacerModels.node.replace(
      Layer.succeed(
        PacerModels.Service,
        PacerModels.Service.of({
          get: () =>
            Effect.succeed({
              at: 0,
              pacer: { compactTokens: ["auto", "cold", "before-cold"], webTools: false },
              models: [
                { id: "claude-e2e", summaries: [{ provider: "claude", writes: true }] },
                { id: "kimi-e2e", summaries: [{ provider: "kimi", writes: true }] },
                { id: "kimi-e2e-mini", summaries: [{ provider: "kimi", writes: true }] },
              ],
            }),
          changes: () => Effect.die("unused") as never,
          refresh: () => Effect.void,
        }),
      ),
    ),
  ]),
)

const reset = (next: PacerSummaries.Decision = { by: "cliproxypacer" }) => {
  fake.seen.length = 0
  fake.compact = "readable"
  fake.header = "warm; model=kimi-e2e; writer=server"
  fake.users = false
  fake.arrived = Promise.withResolvers<void>()
  fake.views.clear()
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

/** A chat of two exchanges on `model`, and `newest` (a prompt not answered yet) when given, stored as its history. */
const chat = (name: string, model: SessionRunnerModel.Resolved, newest?: string) =>
  stored(name, model, [
    user("Plan a dark mode."),
    assistant("Here is a five-step plan.", model),
    user("Now list three risks."),
    assistant("Missed styles, contrast, preference behaviour.", model),
    ...(newest === undefined ? [] : [user(newest)]),
  ])

/** `messages` stored as the history of a subagent's chat on `model` (it has a parent), whose steps offer `tools`. */
const stored = Effect.fnUntraced(function* (
  name: string,
  model: SessionRunnerModel.Resolved,
  messages: ReadonlyArray<SessionMessage.Info>,
  tools: ReadonlyArray<ToolDefinition> = [],
) {
  const id = Session.ID.make(`ses_pacer_summary_${name}`)
  const parentID = Session.ID.make(`ses_pacer_summary_${name}_parent`)
  const session = yield* insertSession(id, parentID)
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
      tools: { definitions: [...tools], execute: () => Effect.die("Compaction must not execute tools") },
    },
  }
})

/** An answer of `model` with `content` (its text, signed thinking, tool calls), as a finished step stores it. */
const answer = (model: SessionRunnerModel.Resolved, content: ReadonlyArray<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: model.ref,
    content,
    tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  })
const thought = (text: string, signature: string) => ({ type: "reasoning", text, native: { signature } })
const read = ToolDefinition.make({
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
})

/**
 * A Claude chat of the kind CLIProxyPacer's rendering of a `/responses/compact` request broke (the owner's chat, its
 * row 2778, read 15,333 of ~146k prompt tokens): a tool call whose result the user's text follows, and signed thinking
 * in every answer.
 */
const toolHistory = (model: SessionRunnerModel.Resolved) => [
  user("Read notes.txt and sum the digits of line three."),
  answer(model, [
    thought("I should read the file first.", "sig-1"),
    { type: "text", text: "Reading it." },
    {
      type: "tool",
      id: "toolu_1",
      name: "read",
      state: { status: "completed", input: { path: "notes.txt" }, content: [{ type: "text", text: "4711" }] },
      time: { created: 0 },
    },
  ]),
  user("Also tell me whether the sum is prime."),
  answer(model, [thought("4+7+1+1 = 13.", "sig-2"), { type: "text", text: "The sum is 13, which is prime." }]),
  user("Now multiply it by three."),
  answer(model, [thought("13 × 3 = 39.", "sig-3"), { type: "text", text: "39." }]),
]

/** A Claude model on CLIProxyPacer whose variant sets `options` (its thinking), as the provider builds it. */
const claudeWith = (options: AnthropicCompatible.Config["providerOptions"]) =>
  resolved(
    AnthropicCompatible.configure({
      auth: Auth.bearer(key),
      baseURL,
      provider: "cliproxypacer",
      providerOptions: options,
    }).model("claude-e2e"),
  )

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

    expect(plans).toEqual([{ sessionID: session.id, parentID: session.parentID, model: "kimi-e2e" }])
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
    // The history before the newest exchange, which openforge keeps itself.
    expect(sent?.body).toMatchObject({
      model: "kimi-e2e",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a dark mode." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is a five-step plan." }] },
      ],
    })
    expect(sent?.body.input).toHaveLength(2)
    expect(String(sent?.body.instructions)).toContain("Session instructions")
    expect(sent?.body).not.toHaveProperty("stream")

    // The record: CLIProxyPacer's summary without its prefix, who wrote it and on which model, the newest exchange kept.
    const stored = yield* record(session.id)
    expect(stored.summary).toBe(cppSummary)
    expect(stored.writer).toEqual({ by: "cliproxypacer", cold: false, userMessages: 2 })
    expect(stored.model).toEqual(pacerRef("kimi-e2e"))
    expect(stored.metadata?.keepID).toBe(messages[2]!.id)
    // Its usage as CLIProxyPacer's answer gives it: the cache writes priced as writes, the thinking as output once.
    expect(stored.tokens).toEqual(compactRecorded.tokens)
    expect(stored.cost).toBeCloseTo(compactRecorded.cost, 12)

    // The chat's next step opens with that summary.
    const db = (yield* Database.Service).db
    const history = yield* SessionHistory.load(db, session.id, kimi.ref)
    const next = JSON.stringify(toLLMMessages(history, kimi.ref)[0])
    expect(next).toContain(cppSummary)
    expect(next).not.toContain("Context summary from previous turns")
  }),
)

/**
 * The body of the step `context` would send with `messages`, through the runner's request path and client, to `path`
 * (a Claude model's step goes to `/v1/messages`).
 */
const stepBody = Effect.fnUntraced(function* (
  context: SessionContext.Loaded,
  messages: ReadonlyArray<SessionMessage.Info>,
  path = "/v1/responses",
) {
  const transcript = SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
  })
  const step = yield* (yield* SessionModelRequest.Service).primary({
    session: context.session,
    agent: context.agent.id,
    model: context.model,
    tools: context.tools,
    system: transcript.system,
    messages: transcript.messages,
  })
  const before = fake.seen.length
  yield* (yield* LLMClient.Service).stream(step.request, step.options).pipe(Stream.runDrain)
  const sent = fake.seen.slice(before).filter((item) => item.path === path)
  expect(sent).toHaveLength(1)
  return sent[0]!.body
})

const occurrences = (body: Record<string, unknown>, text: string) =>
  JSON.stringify(body).split(JSON.stringify(text).slice(1, -1)).length - 1

it.effect(
  "CLIProxyPacer gets the history before openforge's kept part, the step's own first items; the next step carries the newest message once",
  () =>
    Effect.gen(function* () {
      reset()
      fake.users = true
      fake.header = "warm; model=kimi-e2e; writer=server; user_messages=2"
      const newest = "Write the toggle's tests."
      const { session, messages, context } = yield* chat("prefix", kimi, newest)
      const step = yield* stepBody(context, messages)
      expect(step.input).toHaveLength(5)
      fake.seen.length = 0

      const compaction = yield* SessionCompaction.Service
      expect(
        yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
      ).toEqual({ status: "completed" })
      const sent = compactions()[0]!.body
      // The same leading bytes as the step: its model, instructions, tools and cache key, then its first items up to
      // the part openforge keeps (the newest prompt), which is not in it.
      for (const name of ["model", "instructions", "tools", "prompt_cache_key"])
        expect(JSON.stringify(sent[name])).toBe(JSON.stringify(step[name]))
      expect(JSON.stringify(sent.input)).toBe(JSON.stringify((step.input as unknown[]).slice(0, 4)))
      expect(occurrences(sent, newest)).toBe(0)

      // CLIProxyPacer's list of the user's messages holds the history's two; openforge keeps the newest beside it.
      const stored = yield* record(session.id)
      expect(stored.metadata?.keepID).toBe(messages[4]!.id)
      expect(stored.summary).toContain('<message n="2">Now list three risks.</message>')
      expect(stored.writer).toEqual({ by: "cliproxypacer", cold: false, userMessages: 2 })

      // The next step, as sent: the summary with the list, and the newest message exactly once.
      const next = yield* stepBody(context, yield* (yield* SessionStore.Service).context(session.id))
      expect(occurrences(next, cppSummary)).toBe(1)
      expect(occurrences(next, "<earlier-user-messages>")).toBe(1)
      expect(occurrences(next, newest)).toBe(1)
    }),
)

const systemItem = (step: Record<string, unknown>) => ({
  type: "message",
  role: "system",
  content: (step.system as Array<{ text: string }>).map((block) => ({ type: "input_text", text: block.text })),
})

it.effect("a Messages chat CLIProxyPacer writes for gets its request rendered as Responses, at the same address", () =>
  Effect.gen(function* () {
    reset()
    fake.header = "cold; model=kimi-e2e-mini; writer=server"
    const { session, messages, context } = yield* chat("messages", claude)
    const step = yield* stepBody(context, messages, "/v1/messages")
    fake.seen.length = 0
    const compaction = yield* SessionCompaction.Service
    expect(
      yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
    ).toEqual({ status: "completed" })
    expect(plans).toEqual([{ sessionID: session.id, parentID: session.parentID, model: "claude-e2e" }])
    const [sent] = compactions()
    expect(own()).toEqual([])
    expect(sent?.headers.authorization).toBe(`Bearer ${key}`)
    expect(sent?.headers["x-pacer-kind"]).toBe("compaction")
    // The step's system blocks first, each its own part, as CLIProxyPacer renders them back; nothing joined into
    // `instructions`.
    expect(sent?.body).not.toHaveProperty("instructions")
    expect(sent?.body).toMatchObject({
      model: "claude-e2e",
      input: [
        systemItem(step),
        { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a dark mode." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is a five-step plan." }] },
      ],
    })
    expect(sent?.body.input).toHaveLength(3)
    // Written on CLIProxyPacer's cheaper model for the cold chat, as its header says.
    const stored = yield* record(session.id)
    expect(stored.writer).toEqual({ by: "cliproxypacer", cold: true })
    expect(stored.model).toEqual(pacerRef("kimi-e2e-mini"))
  }),
)

// CLIProxyPacer renders a Messages chat's summary request back into Messages (`claude_responses.rs`): `instructions`
// becomes one system block, and each text part of a `system` input item one more, in order. Joined into `instructions`,
// four system blocks came back as one (on a Claude login, CLIProxyPacer's first user message then differed from the
// step's at the first join: `run/evidence/cpp-summaries/live-warm-claude/`).
it.effect("a Messages chat's summary request carries its step's four system blocks as one system item, in order", () =>
  Effect.gen(function* () {
    reset()
    const hint = new CacheHint({ type: "ephemeral" })
    const system = [
      { type: "text" as const, text: "You are an agent.\nFollow the user's lead.\n", cache: hint },
      { type: "text" as const, text: "# Your Model\n- claude-e2e" },
      { type: "text" as const, text: "# Code Mode\n\nCall tools as code." },
      { type: "text" as const, text: "A worktree hint.", cache: hint },
    ]
    const request = ai.request({
      model: claude.model,
      system,
      messages: [Message.user("Plan a dark mode."), Message.assistant("Here is a five-step plan.")],
    })
    const llm = yield* LLMClient.Service
    yield* llm.stream(request).pipe(Stream.runDrain)
    const step = fake.seen.find((item) => item.path === "/v1/messages")!.body
    yield* llm.compact(PacerSummaries.responses(request), { mechanism: "endpoint" })
    const sent = compactions()[0]!.body

    expect((step.system as Array<{ text: string }>).map((block) => block.text)).toEqual(system.map((part) => part.text))
    expect(sent).not.toHaveProperty("instructions")
    // The cache hints have no Responses form: the parts carry the text alone.
    expect(sent.input).toEqual([
      systemItem(step),
      { type: "message", role: "user", content: [{ type: "input_text", text: "Plan a dark mode." }] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Here is a five-step plan." }],
      },
    ])
  }),
)

/**
 * The conversation in a body, item by item, as CLIProxyPacer renders a Responses body back into Messages
 * (`claude_responses.rs`): a reasoning item is the thinking block `{thinking: summary text, signature: encrypted
 * content}`, or a redacted one for `claude-redacted-thinking:<data>`. A Messages body's blocks read the same way.
 */
const REDACTED = "claude-redacted-thinking:"
const conversation = (body: Record<string, unknown>) =>
  "messages" in body
    ? (body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).flatMap((message) =>
        message.content.map((block) => {
          if (block.type === "thinking") return `thinking ${JSON.stringify([block.thinking, block.signature])}`
          if (block.type === "redacted_thinking") return `thinking ${JSON.stringify(["", `${REDACTED}${block.data}`])}`
          if (block.type === "tool_use") return `tool_use ${block.id}`
          if (block.type === "tool_result") return `tool_result ${block.tool_use_id}`
          return `${message.role} ${block.text}`
        }),
      )
    : (body.input as Array<Record<string, unknown>>).flatMap((item) => {
        if (item.type === "reasoning") {
          const text = (item.summary as Array<{ text: string }>).map((part) => part.text).join("")
          return [`thinking ${JSON.stringify([text, item.encrypted_content])}`]
        }
        if (item.type === "function_call") return [`tool_use ${item.call_id}`]
        if (item.type === "function_call_output") return [`tool_result ${item.call_id}`]
        if (item.role === "system") return []
        return (item.content as Array<{ text: string }>).map((part) => `${item.role} ${part.text}`)
      })

// The step's thinking blocks go to CLIProxyPacer as reasoning items in the same places, with the same text and
// signatures, so the summary's prefix is the step's (`run/evidence/cpp-summaries/live-warm-claude-2/`: without them,
// the read stopped at the first assistant message with thinking).
it.effect(
  "a Messages chat's summary request carries exactly its step's thinking blocks, in place, as reasoning items",
  () =>
    Effect.gen(function* () {
      reset()
      const key = claude.model.route.providerMetadataKey ?? claude.model.provider
      const signed = (text: string, signature: string) => ({
        type: "reasoning" as const,
        text,
        providerMetadata: { [key]: { signature } },
      })
      const request = ai.request({
        model: claude.model,
        system: "You are an agent.",
        messages: [
          Message.user("Plan a dark mode."),
          Message.assistant([
            signed("I should read the styles first.", "sig-1"),
            { type: "tool-call", id: "toolu_1", name: "read", input: { path: "styles.css" } },
          ]),
          Message.make({
            role: "tool",
            content: [{ type: "tool-result", id: "toolu_1", name: "read", result: { type: "text", value: "body {}" } }],
          }),
          Message.assistant([
            // Safety-filtered thinking: no text, its data alone.
            { type: "reasoning", text: "", providerMetadata: { [key]: { redactedData: "opaque-1" } } },
            signed("The styles use one variable.", "sig-2"),
            { type: "text", text: "Here is the plan." },
          ]),
          Message.user("Now list three risks."),
          Message.assistant([
            // Another model's readable reasoning, without a signature: the step leaves it out.
            { type: "reasoning", text: "Thinking on another model." },
            signed("Contrast first.", "sig-3"),
            signed("Then preferences.", "sig-4"),
            { type: "text", text: "Missed styles, contrast, preference behaviour." },
          ]),
        ],
      })
      const llm = yield* LLMClient.Service
      yield* llm.stream(request).pipe(Stream.runDrain)
      const step = fake.seen.find((item) => item.path === "/v1/messages")!.body
      yield* llm.compact(PacerSummaries.responses(request), { mechanism: "endpoint" })
      const sent = compactions()[0]!.body

      // Item by item the same conversation, the thinking blocks included, byte for byte.
      expect(conversation(sent)).toEqual(conversation(step))
      expect(conversation(step).filter((item) => item.startsWith("thinking"))).toEqual([
        `thinking ${JSON.stringify(["I should read the styles first.", "sig-1"])}`,
        `thinking ${JSON.stringify(["", `${REDACTED}opaque-1`])}`,
        `thinking ${JSON.stringify(["The styles use one variable.", "sig-2"])}`,
        `thinking ${JSON.stringify(["Contrast first.", "sig-3"])}`,
        `thinking ${JSON.stringify(["Then preferences.", "sig-4"])}`,
      ])
      expect(JSON.stringify(sent)).not.toContain("Thinking on another model.")
      // The reasoning items as sent; a redacted one has no summary.
      expect((sent.input as Array<Record<string, unknown>>).filter((item) => item.type === "reasoning")).toEqual([
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should read the styles first." }],
          encrypted_content: "sig-1",
        },
        { type: "reasoning", summary: [], encrypted_content: `${REDACTED}opaque-1` },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "The styles use one variable." }],
          encrypted_content: "sig-2",
        },
        { type: "reasoning", summary: [{ type: "summary_text", text: "Contrast first." }], encrypted_content: "sig-3" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Then preferences." }],
          encrypted_content: "sig-4",
        },
      ])
    }),
)

it.effect("a Messages chat whose reasoning came from another model: its summary request carries none", () =>
  Effect.gen(function* () {
    reset()
    const request = ai.request({
      model: claude.model,
      system: "You are an agent.",
      messages: [
        Message.user("Plan a dark mode."),
        Message.assistant([
          { type: "reasoning", text: "Readable reasoning of another model." },
          { type: "text", text: "Here is the plan." },
        ]),
      ],
    })
    const llm = yield* LLMClient.Service
    yield* llm.stream(request).pipe(Stream.runDrain)
    const step = fake.seen.find((item) => item.path === "/v1/messages")!.body
    yield* llm.compact(PacerSummaries.responses(request), { mechanism: "endpoint" })
    const sent = compactions()[0]!.body
    expect(JSON.stringify(step)).not.toContain("Readable reasoning of another model.")
    expect((sent.input as Array<{ type: string }>).some((item) => item.type === "reasoning")).toBe(false)
    expect(conversation(sent)).toEqual(conversation(step))
  }),
)

/** The requests the fake CLIProxyPacer got, as `METHOD path`. */
const wire = () => fake.seen.map((item) => `${item.method} ${item.path}`)

/** The chat's view at CLIProxyPacer: warm for ten more minutes, with `settings` of its own. */
const warmView = (uuid: string, provider: string, model: string, settings: Record<string, unknown> = {}) => ({
  id: uuid,
  session_id: 7,
  provider,
  model,
  warm: true,
  warm_until: Date.now() + 600_000,
  settings,
})

const on = Effect.gen(function* () {
  yield* (yield* PacerStatus.Service).set({ state: "on", since: 0, refused: false })
})

// A Claude chat follows `compaction.writer` as every chat on CLIProxyPacer: with `server` or unset CLIProxyPacer writes
// it from `/v1/responses/compact`, the steps' Messages request rendered as Responses (its system blocks one part each,
// its signed thinking as reasoning items in place), which CLIProxyPacer compares with the chat's last Messages request
// to write from that one's bytes while the cache is warm.
planned.live(
  "a Claude chat, writer server or unset: CLIProxyPacer writes it from /v1/responses/compact, the step's system blocks and thinking in place; its own writer set to server once",
  () =>
    Effect.gen(function* () {
      yield* on
      for (const writer of ["server", undefined] as const) {
        reset()
        fake.header = "warm; model=claude-e2e; writer=server; history=last-turn"
        const history = toolHistory(claude)
        const { session, context } = yield* stored(`claude-compact-${writer ?? "unset"}`, claude, history, [read])
        const uuid = PacerSessionID.make(session.id)
        fake.views.set(
          uuid,
          warmView(uuid, "claude", "claude-e2e", writer === undefined ? {} : { "compaction.writer": writer }),
        )
        const step = yield* stepBody(context, history.slice(0, -1), "/v1/messages")
        fake.seen.length = 0
        expect(
          yield* (yield* SessionCompaction.Service).compact({
            reason: "auto",
            context,
            estimate: { measured: 190_000, estimated: 0 },
          }),
        ).toEqual({ status: "completed" })

        // The chat's own writer set to `server` only when it isn't already.
        expect(wire()).toEqual([
          `GET /pacer/v1/sessions/${uuid}`,
          "GET /pacer/v1/settings",
          ...(writer === "server" ? [] : [`PATCH /pacer/v1/sessions/${uuid}`]),
          "POST /v1/responses/compact",
        ])
        if (writer === undefined) expect(fake.seen[2]?.body).toEqual({ "compaction.writer": "server" })
        expect(own()).toEqual([])
        const sent = compactions()[0]!
        expect(sent.headers).toMatchObject({
          authorization: `Bearer ${key}`,
          "x-pacer-session": uuid,
          "x-pacer-parent-session": PacerSessionID.make(session.parentID!),
          "x-pacer-kind": "compaction",
        })
        expect(sent.body.model).toBe("claude-e2e")
        // The step's system blocks as the first item, one part each, in order; nothing joined into `instructions`.
        expect(sent.body).not.toHaveProperty("instructions")
        expect((step.system as unknown[]).length).toBeGreaterThan(0)
        expect((sent.body.input as unknown[])[0]).toEqual(systemItem(step))
        // The history before the kept exchange, item by item the step's, its signed thinking as reasoning items.
        const items = conversation(sent.body)
        expect(items).toEqual(conversation(step).slice(0, items.length))
        expect(items).toEqual([
          "user Read notes.txt and sum the digits of line three.",
          `thinking ${JSON.stringify(["I should read the file first.", "sig-1"])}`,
          "assistant Reading it.",
          "tool_use toolu_1",
          "tool_result toolu_1",
          "user Also tell me whether the sum is prime.",
          `thinking ${JSON.stringify(["4+7+1+1 = 13.", "sig-2"])}`,
          "assistant The sum is 13, which is prime.",
        ])

        const kept = yield* record(session.id)
        expect(kept.summary).toBe(cppSummary)
        expect(kept.writer).toEqual({ by: "cliproxypacer", cold: false })
        expect(kept.model).toEqual(pacerRef("claude-e2e"))
        expect(kept.metadata?.keepID).toBe(history[4]!.id)
      }
    }),
)

planned.live(
  "a Claude chat, writer client: openforge writes its summary as the chat's own /v1/messages request; nothing set",
  () =>
    Effect.gen(function* () {
      reset()
      yield* on
      const { session, context } = yield* stored("claude-client", claude, toolHistory(claude), [read])
      const uuid = PacerSessionID.make(session.id)
      fake.views.set(uuid, warmView(uuid, "claude", "claude-e2e", { "compaction.writer": "client" }))
      expect(
        yield* (yield* SessionCompaction.Service).compact({
          reason: "auto",
          context,
          estimate: { measured: 190_000, estimated: 0 },
        }),
      ).toEqual({ status: "completed" })

      // The settings read, then one request of the chat: no PATCH, no /v1/responses/compact.
      expect(wire()).toEqual([`GET /pacer/v1/sessions/${uuid}`, "GET /pacer/v1/settings", "POST /v1/messages"])
      const sent = fake.seen[2]!
      expect(sent.headers).toMatchObject({
        authorization: `Bearer ${key}`,
        "x-pacer-session": uuid,
        "x-pacer-parent-session": PacerSessionID.make(session.parentID!),
        "x-pacer-kind": "compaction",
      })
      expect(sent.body.model).toBe("claude-e2e")
      // The whole conversation, its last answer included, then the summary prompt.
      const messages = sent.body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
      expect(messages.at(-2)?.content.map((block) => block.text ?? block.type)).toEqual(["thinking", "39."])
      expect(messages.at(-1)?.content[0]?.text).toStartWith("You MUST summarize the conversation above")

      const kept = yield* record(session.id)
      expect(kept.summary).toBe(ownSummary)
      expect(kept.writer).toEqual({ by: "openforge" })
      expect(kept.model).toEqual(claude.ref)
    }),
)

/** The chat's own writer `client` at CLIProxyPacer, so openforge writes: its own summary request is the subject. */
const ownWriter = (sessionID: Session.ID) => {
  const uuid = PacerSessionID.make(sessionID)
  fake.views.set(uuid, warmView(uuid, "claude", "claude-e2e", { "compaction.writer": "client" }))
}

// openforge's own summary of a Claude chat (writer `client`, or CLIProxyPacer couldn't): the prefix it shares with the
// last step is that step's bytes up to its last message: model, system, tools,
// tool_choice, thinking, output limit, and the cache markers where the step put them. A marker moved onto the prompt
// leaves the read to the cache's look-back over the blocks of the answer between them; a thinking budget fitted under
// a smaller output limit (16,000 became 15,000) misses every cached message, as a changed budget does at Anthropic.
planned.live(
  "openforge's summary request of a Claude chat is its last step's body up to that step's last message, cache markers and thinking included",
  () =>
    Effect.gen(function* () {
      yield* on
      const compaction = yield* SessionCompaction.Service
      for (const [name, thinking] of [
        ["adaptive", { thinking: { type: "adaptive", display: "summarized" }, effort: "high" }],
        ["budget", { thinking: { type: "enabled", budgetTokens: 16_000 } }],
      ] as const) {
        reset()
        const model = claudeWith(thinking)
        const history = toolHistory(model)
        const { session, context } = yield* stored(`claude-body-${name}`, model, history, [read])
        ownWriter(session.id)
        // The last step: everything before its answer, as the runner sends it.
        const step = yield* stepBody(context, history.slice(0, -1), "/v1/messages")
        fake.seen.length = 0
        expect(
          yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
        ).toEqual({ status: "completed" })
        const sent = fake.seen.find((item) => item.path === "/v1/messages")!.body
        const stepMessages = step.messages as unknown[]
        const sentMessages = sent.messages as unknown[]

        expect(JSON.stringify({ ...sent, messages: undefined })).toBe(JSON.stringify({ ...step, messages: undefined }))
        expect(JSON.stringify(sentMessages.slice(0, stepMessages.length))).toBe(JSON.stringify(stepMessages))
        // The step's marker stays on its last message; its answer and the prompt carry none (tools, system and that
        // message hold all four).
        expect(JSON.stringify(stepMessages.at(-1))).toContain("cache_control")
        expect(sentMessages.slice(stepMessages.length).map((message) => (message as { role: string }).role)).toEqual([
          "assistant",
          "user",
        ])
        expect(JSON.stringify(sentMessages.slice(stepMessages.length))).not.toContain("cache_control")
        expect(sent.thinking).toEqual(
          name === "budget" ? { type: "enabled", budget_tokens: 16_000 } : { type: "adaptive", display: "summarized" },
        )
      }
    }),
)

planned.live(
  "a move and a cold ask on a Claude pick: CLIProxyPacer writes it on the pick from /v1/responses/compact, rendered from Messages",
  () =>
    Effect.gen(function* () {
      yield* on
      const compaction = yield* SessionCompaction.Service
      // A Claude chat's move whose picks start with its own model: on it, the system item and thinking in place.
      reset()
      fake.header = "warm; model=claude-e2e; writer=server; history=last-turn"
      const move = yield* stored("move-claude", claude, toolHistory(claude), [read])
      const moveID = PacerSessionID.make(move.session.id)
      expect(
        yield* compaction.compact({
          reason: "move",
          context: move.context,
          models: [pacerRef("claude-e2e"), pacerRef("kimi-e2e-mini")],
        }),
      ).toEqual({ status: "completed" })
      expect(wire()).toEqual([
        `GET /pacer/v1/sessions/${moveID}`,
        "GET /pacer/v1/settings",
        `PATCH /pacer/v1/sessions/${moveID}`,
        "POST /v1/responses/compact",
      ])
      const moved = compactions()[0]!
      expect(moved.headers["x-pacer-kind"]).toBe("compaction")
      expect(moved.body.model).toBe("claude-e2e")
      expect(moved.body).not.toHaveProperty("instructions")
      expect((moved.body.input as Array<{ role?: string }>)[0]?.role).toBe("system")
      expect(conversation(moved.body).filter((item) => item.startsWith("thinking"))).toEqual([
        `thinking ${JSON.stringify(["I should read the file first.", "sig-1"])}`,
        `thinking ${JSON.stringify(["4+7+1+1 = 13.", "sig-2"])}`,
      ])
      expect((yield* record(move.session.id)).writer).toEqual({ by: "cliproxypacer", cold: false })

      // A Responses chat's cold ask on a Claude pick: on the pick, in its rendering, cold.
      reset()
      fake.header = "warm; model=claude-e2e; writer=server"
      const cold = yield* chat("cold-claude-pick", kimi)
      expect(
        yield* compaction.compact({ reason: "cold", context: cold.context, models: [pacerRef("claude-e2e")] }),
      ).toEqual({ status: "completed" })
      expect(own()).toEqual([])
      const asked = compactions()[0]!
      expect(asked.headers["x-pacer-kind"]).toBe("compaction")
      expect(asked.body.model).toBe("claude-e2e")
      expect(asked.body).not.toHaveProperty("instructions")
      expect((asked.body.input as Array<{ role?: string }>).map((item) => item.role)).toEqual([
        "system",
        "user",
        "assistant",
      ])
      const coldRecord = yield* record(cold.session.id)
      expect(coldRecord.writer).toEqual({ by: "cliproxypacer", cold: true })
      expect(coldRecord.model).toEqual(pacerRef("claude-e2e"))
    }),
)

// CLIProxyPacer's compact notice before it moves a chat to another account names models, not variants. Resolved without
// the chat's variant, the chat's own model sent the summary without the steps' effort and thinking, and the summary
// missed every cached message on the account the chat was leaving (2026-11-09, row 13899: effort xhigh dropped, 14,611
// of ~358k read, $1.62).
planned.live(
  "a move whose pick is the chat's own model: openforge's summary keeps the chat's variant, its effort and thinking as the steps send them",
  () =>
    Effect.gen(function* () {
      reset()
      yield* on
      const plain = claudeWith({ thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" })
      const model = { ...plain, ref: Model.Ref.make({ ...plain.ref, variant: Model.VariantID.make("xhigh") }) }
      const history = toolHistory(model)
      const { session, context } = yield* stored("move-variant", model, history, [read])
      ownWriter(session.id)
      const step = yield* stepBody(context, history.slice(0, -1), "/v1/messages")
      fake.seen.length = 0
      expect(
        yield* (yield* SessionCompaction.Service).compact({
          reason: "move",
          context,
          models: [pacerRef("claude-e2e"), pacerRef("kimi-e2e-mini")],
        }),
      ).toEqual({ status: "completed" })
      const sent = fake.seen.find((item) => item.path === "/v1/messages")!.body
      const stepMessages = step.messages as unknown[]

      expect(sent.output_config).toEqual({ effort: "xhigh" })
      expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" })
      expect(JSON.stringify({ ...sent, messages: undefined })).toBe(JSON.stringify({ ...step, messages: undefined }))
      expect(JSON.stringify((sent.messages as unknown[]).slice(0, stepMessages.length))).toBe(
        JSON.stringify(stepMessages),
      )
    }),
)

planned.live(
  "a warm Responses chat: CLIProxyPacer writes its summary, its own writer set to server first; none of openforge's own",
  () =>
    Effect.gen(function* () {
      reset()
      fake.header = "warm; model=kimi-e2e; writer=server"
      yield* on
      const { session, messages, context } = yield* chat("responses-warm", kimi)
      const uuid = PacerSessionID.make(session.id)
      // No writer of its own, none at the key or server level.
      fake.views.set(uuid, warmView(uuid, "kimi", "kimi-e2e"))
      expect(
        yield* (yield* SessionCompaction.Service).compact({
          reason: "auto",
          context,
          estimate: { measured: 190_000, estimated: 0 },
        }),
      ).toEqual({ status: "completed" })

      expect(wire()).toEqual([
        `GET /pacer/v1/sessions/${uuid}`,
        "GET /pacer/v1/settings",
        `PATCH /pacer/v1/sessions/${uuid}`,
        "POST /v1/responses/compact",
      ])
      expect(fake.seen[2]?.body).toEqual({ "compaction.writer": "server" })
      expect(own()).toEqual([])
      const [sent] = compactions()
      expect(sent?.headers).toMatchObject({ "x-pacer-session": uuid, "x-pacer-kind": "compaction" })
      expect(sent?.body.model).toBe("kimi-e2e")
      expect((sent?.body.input as Array<{ role?: string }>).map((item) => item.role)).toEqual(["user", "assistant"])

      const kept = yield* record(session.id)
      expect(kept.summary).toBe(cppSummary)
      expect(kept.writer).toEqual({ by: "cliproxypacer", cold: false })
      expect(kept.model).toEqual(pacerRef("kimi-e2e"))
      expect(kept.metadata?.keepID).toBe(messages[2]!.id)
      expect(kept.tokens).toEqual(compactRecorded.tokens)
      expect(kept.cost).toBeCloseTo(compactRecorded.cost, 12)
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

it.effect(
  "CLIProxyPacer couldn't: a 501, a failure, an answer without a readable summary; openforge writes it, a Claude chat's as /v1/messages",
  () =>
    Effect.gen(function* () {
      for (const [model, path] of [
        [kimi, "/v1/responses"],
        [claude, "/v1/messages"],
      ] as const) {
        for (const [compact, reason] of [
          ["501", "it answered 501"],
          ["500", "it answered 500"],
          ["capsule", "no readable summary"],
        ] as const) {
          reset()
          fake.compact = compact
          const { session, context } = yield* chat(`fallback-${compact}-${model.ref.id}`, model)
          const compaction = yield* SessionCompaction.Service
          expect(
            yield* compaction.compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } }),
          ).toEqual({ status: "completed" })
          expect(compactions()).toHaveLength(1)
          expect(compactions()[0]?.body.model).toBe(String(model.ref.id))
          expect(own().map((item) => item.path)).toEqual([path])
          expect(own()[0]?.headers["x-pacer-kind"]).toBe("compaction")
          const stored = yield* record(session.id)
          expect(stored.summary).toBe(ownSummary)
          expect(stored.writer).toEqual({ by: "openforge", fallback: reason })
          expect(stored.model).toEqual(model.ref)
        }
      }
    }),
)

it.effect("no answer within 4 minutes: openforge writes it, a Claude chat's as /v1/messages", () =>
  Effect.gen(function* () {
    for (const [model, path] of [
      [kimi, "/v1/responses"],
      [claude, "/v1/messages"],
    ] as const) {
      reset()
      fake.compact = "hang"
      const { session, context } = yield* chat(`fallback-timeout-${model.ref.id}`, model)
      const compaction = yield* SessionCompaction.Service
      const fiber = yield* compaction
        .compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => fake.arrived.promise)
      yield* TestClock.adjust("3 minutes")
      expect(own()).toEqual([])
      yield* TestClock.adjust("1 minute")
      expect(yield* Fiber.join(fiber)).toEqual({ status: "completed" })
      expect(own().map((item) => item.path)).toEqual([path])
      expect((yield* record(session.id)).writer).toEqual({ by: "openforge", fallback: "no answer in 4 minutes" })
    }
  }),
)

it.effect("a move and a cold ask: CLIProxyPacer's first usable pick writes it; a cold ask's record says cold", () =>
  Effect.gen(function* () {
    const ref = pacerRef
    const compaction = yield* SessionCompaction.Service
    // A move whose picks start with the chat's own model: on that model.
    reset()
    const warm = yield* chat("move-warm", kimi)
    yield* compaction.compact({
      reason: "move",
      context: warm.context,
      models: [ref("kimi-e2e"), ref("kimi-e2e-mini")],
    })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e" })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e")
    // A move whose picks are the compaction models alone (the account ran out): on the first usable one.
    reset()
    fake.header = "warm; model=kimi-e2e-mini; writer=server"
    const out = yield* chat("move-out", kimi)
    yield* compaction.compact({
      reason: "move",
      context: out.context,
      models: [ref("not-served"), ref("kimi-e2e-mini"), ref("kimi-e2e")],
    })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e-mini" })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e-mini")
    expect((yield* record(out.session.id)).model).toEqual(ref("kimi-e2e-mini"))
    // The move's record: as CLIProxyPacer's header says.
    expect((yield* record(out.session.id)).writer).toEqual({ by: "cliproxypacer", cold: false })
    // A cold ask: cold. Its record says so though CLIProxyPacer's header says `warm` (it wrote on the pick sent).
    reset()
    fake.header = "warm; model=kimi-e2e-mini; writer=server"
    const cold = yield* chat("cold-ask", claude)
    yield* compaction.compact({ reason: "cold", context: cold.context, models: [ref("kimi-e2e-mini")] })
    expect(plans[0]).toMatchObject({ model: "kimi-e2e-mini" })
    expect(compactions()[0]?.body.model).toBe("kimi-e2e-mini")
    expect((yield* record(cold.session.id)).writer).toEqual({ by: "cliproxypacer", cold: true })
    // And without any header (lost behind keep-alive bytes).
    reset()
    fake.header = undefined
    const bare = yield* chat("cold-ask-bare", claude)
    yield* compaction.compact({ reason: "cold", context: bare.context, models: [ref("kimi-e2e-mini")] })
    expect((yield* record(bare.session.id)).writer).toEqual({ by: "cliproxypacer", cold: true })
  }),
)

it.effect(
  "a chat on CLIProxyPacer without a pacer: openforge's own summary, naming no writer, as on any provider",
  () =>
    Effect.gen(function* () {
      reset()
      decision.current = undefined
      const { session, context } = yield* chat("no-pacer", kimi)
      expect(
        yield* (yield* SessionCompaction.Service).compact({
          reason: "auto",
          context,
          estimate: { measured: 190_000, estimated: 0 },
        }),
      ).toEqual({ status: "completed" })
      expect(plans).toHaveLength(1)
      expect(compactions()).toEqual([])
      expect(own().map((item) => item.path)).toEqual(["/v1/responses"])
      const stored = yield* record(session.id)
      expect(stored.summary).toBe(ownSummary)
      expect(stored.writer).toBeUndefined()
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
