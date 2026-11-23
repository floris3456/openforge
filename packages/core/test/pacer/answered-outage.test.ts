import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect } from "bun:test"
import { AIError, ai, LLMClient } from "@opencode/ai/effect"
import { OpenAICompatibleResponses } from "@opencode/ai/providers"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSummaries } from "@opencode/core/pacer/summaries"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { ServiceClient } from "@opencode/core/service-client"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { WellKnown } from "@opencode/core/wellknown"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { emptyWellknownNode } from "../fixture/config-nodes"
import { testEffect } from "../lib/effect"

// The answers of 2026-11-23 on theorysnap: CPP's pair up, both instances' `/healthz` answering, and one model's
// requests refused with a 503 and `Retry-After: 30`. openforge read "CPP is down" as an outage, moved between the two
// addresses at every retry and retried at once: about 5 requests a second for 15 minutes, each move rebuilding CPP's
// provider. Synthetic: no real address, account or key.
const key = "k-answered-outage"
const modelID = "deepseek-e2e"
const summary = "## Objective\n- the summary"

const retryAfter = 30_000

/** Bodies as CPP's OpenAI routes give them, each with `Retry-After: 30`. */
const refusal = (message: string, code: string) => () =>
  new Response(JSON.stringify({ error: { message, type: "server_error", code } }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": String(retryAfter / 1_000) },
  })
// `pair_health.rs`'s `cpp_down` until CPP had a code for it: the model's accounts are blocked by the pair's network rule.
const blockedBefore = refusal(
  `CPP is down: no account for ${modelID} can be reached from here (this instance leaves from 2001:db8::1 and the other one from 192.0.2.7)`,
  "internal_server_error",
)
// The same answer since CPP has its code (`pair_health.rs`, `no_reachable`), in `auth_unavailable`'s shape.
const blocked = refusal(
  `no_reachable_account: No account for ${modelID} can be reached from here: its proxy home cannot be reached from here: refused`,
  "internal_server_error",
)
// `pair_forward.rs`'s `cpp_down`: the instance itself cannot serve, nor reach one that can.
const down = refusal("CPP is down: the active instance cannot be reached", "cpp_down")

/** One instance of the pair: `/healthz` answers, `/v1/responses` streams a summary unless `answer` refuses it. */
const instance = () => {
  const state = { answer: undefined as (() => Response) | undefined, requests: 0, health: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/healthz") {
        state.health++
        return new Response("ok")
      }
      if (url.pathname !== "/v1/responses") return new Response("not found", { status: 404 })
      state.requests++
      if (state.answer) return state.answer()
      return new Response(
        [
          { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", item_id: "msg_1", delta: summary },
          { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 400, output_tokens: 20 } } },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { state, server, root: `http://127.0.0.1:${server.port}` }
}
const a = instance()
const b = instance()

// CPP set up at `a` in global config, as an install sets it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "answered-outage-"))
fs.mkdirSync(path.join(root, "config"), { recursive: true })
fs.writeFileSync(
  path.join(root, "config", "opencode.json"),
  JSON.stringify({ providers: { cliproxypacer: { settings: { baseURL: `${a.root}/v1`, apiKey: key } } } }),
)
afterAll(() => {
  a.server.stop(true)
  b.server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  for (const item of [a, b]) Object.assign(item.state, { answer: undefined, requests: 0, health: 0 })
})

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
      PacerEndpoint.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      // The model client as the service runs it, every CPP request sent to the endpoint's address now.
      llmClient.replace(ServiceClient.llm()),
      // The real endpoint, over config read from `root`.
      PacerEndpoint.node.replace(PacerEndpoint.configured({ system: false })),
      Global.node.replace(Global.layerWith({ config: path.join(root, "config"), home: path.join(root, "home") })),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
      // A server without CPP's tools: no list read waits before the request (PacerTools.list).
      PacerModels.node.replace(
        Layer.succeed(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => Effect.succeed({ at: 0, pacer: { compactTokens: [], webTools: false }, models: [] }),
            changes: () => Stream.never,
            refresh: () => Effect.void,
          }),
        ),
      ),
      // openforge writes the summary itself, as the cold ask's `writer: client` had it.
      PacerSummaries.node.replace(
        Layer.succeed(
          PacerSummaries.Service,
          PacerSummaries.Service.of({ plan: () => Effect.succeed({ by: "openforge" }) }),
        ),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      SessionRunnerModel.node.replace(Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.die("unused") })),
    ],
  ),
)

/** The endpoint, with the pair's two addresses as `a`'s capabilities name them; and each change of it from now on. */
const paired = Effect.gen(function* () {
  const endpoints = yield* PacerEndpoint.Service
  const home = yield* endpoints.get()
  if (!home || !endpoints.learn) return yield* Effect.die(new Error("CPP is not set up"))
  yield* endpoints.learn(
    home,
    PacerEndpoint.addressesOf([
      { url: a.root, instance: "a", active: true },
      { url: b.root, instance: "b", active: false },
    ]) ?? [],
  )
  expect((yield* endpoints.addresses?.() ?? Effect.succeed([])).map((item) => item.root)).toEqual([a.root, b.root])
  const moves: Array<string | undefined> = []
  yield* endpoints.changes().pipe(
    Stream.drop(1),
    Stream.runForEach((endpoint) => Effect.sync(() => moves.push(endpoint?.root))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return { endpoints, moves }
})

const at = (endpoints: PacerEndpoint.Interface) => endpoints.get().pipe(Effect.map((endpoint) => endpoint?.root))

const model = SessionRunnerModel.resolved(
  OpenAICompatibleResponses.configure({ apiKey: key, baseURL: `${a.root}/v1`, provider: "cliproxypacer" }).model(
    modelID,
  ),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  },
)

/** One step's request through the service's model client; its failure. */
const step = Effect.gen(function* () {
  const llm = yield* LLMClient.Service
  const failure = yield* llm
    .stream(ai.request({ model: model.model, prompt: "Hello" }))
    .pipe(Stream.runDrain, Effect.flip, Effect.option, Effect.map(Option.getOrUndefined))
  if (!(failure instanceof AIError)) return yield* Effect.die(new Error("the step did not fail"))
  return failure
})

const input = (failure: AIError) => ({
  cause: failure,
  error: toSessionError(failure),
  agent: Agent.defaultID,
  model: model.ref,
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(failure),
})

describe("an answered 503 of CPP's pair", () => {
  for (const [name, answer] of [
    ["CPP's no_reachable_account", blocked],
    ["the 'CPP is down: no account … can be reached from here' before it", blockedBefore],
  ] as const)
    it.live(`${name} is a wait for the model at its Retry-After, and moves nothing`, () =>
      Effect.gen(function* () {
        const pair = yield* paired
        a.state.answer = answer
        b.state.answer = answer
        const decide = yield* SessionRunnerRetry.policy(Session.ID.make("ses_blocked"), undefined, pair.endpoints)
        for (let i = 0; i < 5; i++) {
          const decision = yield* decide(input(yield* step))
          expect(decision).toMatchObject({ retry: true, delay: retryAfter, login: model.ref })
        }
        expect(yield* at(pair.endpoints)).toBe(a.root)
        expect(pair.moves).toEqual([])
        expect([a.state.requests, b.state.requests]).toEqual([5, 0])
        // Not even asked whether the other instance answers.
        expect(b.state.health).toBe(0)
      }),
    )

  it.effect("'CPP is down' from both instances moves once, then waits its Retry-After where it is", () =>
    Effect.gen(function* () {
      const pair = yield* paired
      a.state.answer = down
      b.state.answer = down
      const decide = yield* SessionRunnerRetry.policy(Session.ID.make("ses_down"), undefined, pair.endpoints)

      // The move, and the step at the other address at once.
      expect(yield* decide(input(yield* step))).toMatchObject({ retry: true, delay: 0 })
      expect(yield* at(pair.endpoints)).toBe(b.root)
      for (let i = 0; i < 4; i++) {
        const decision = yield* decide(input(yield* step))
        expect(decision.retry).toBe(true)
        expect(decision.retry && decision.delay).toBeGreaterThanOrEqual(retryAfter)
        if (decision.retry) yield* TestClock.adjust(i === 0 ? retryAfter - 1 : 0)
      }
      expect(pair.moves).toEqual([b.root])
      expect([a.state.requests, b.state.requests]).toEqual([1, 4])

      // A Retry-After later it may move again, once.
      yield* TestClock.adjust(1)
      expect(yield* decide(input(yield* step))).toMatchObject({ retry: true, delay: 0 })
      expect(yield* decide(input(yield* step))).toMatchObject({ retry: true })
      expect(pair.moves).toEqual([b.root, a.root])
    }),
  )
})

const user = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })
const assistant = (text: string) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: model.ref,
    content: [{ type: "text", text }],
    tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  })

/** A stored chat of two exchanges on the model, and the context a compaction of it gets. */
const chat = Effect.fnUntraced(function* (name: string) {
  const id = Session.ID.make(`ses_answered_${name}`)
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
    .run()
    .pipe(Effect.orDie)
  const messages = [
    user("Plan a dark mode."),
    assistant("Here is a five-step plan."),
    user("Now list three risks."),
    assistant("Missed styles, contrast, preference behaviour."),
  ]
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
  const session = yield* (yield* SessionStore.Service).get(id)
  if (!session) return yield* Effect.die(`session missing: ${id}`)
  return {
    session,
    messages,
    model,
    agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
    initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
    tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
  }
})

describe("a compaction openforge writes on a model CPP refuses", () => {
  it.live("the cold ask's, on its pick, fails after one request, so the step goes on without it", () =>
    Effect.gen(function* () {
      const pair = yield* paired
      a.state.answer = blockedBefore
      b.state.answer = blockedBefore
      const compaction = yield* SessionCompaction.Service
      const context = yield* chat("cold")
      const result = yield* compaction
        .compact({ reason: "cold", context, models: [model.ref] })
        .pipe(Effect.timeout("5 seconds"), Effect.exit)
      expect(result._tag).toBe("Success")
      expect(result._tag === "Success" && result.value.status).toBe("failed")
      expect([a.state.requests, b.state.requests]).toEqual([1, 0])
      expect(pair.moves).toEqual([])
    }),
  )

  for (const [name, answer] of [
    ["no account reachable", blockedBefore],
    ["CPP down", down],
  ] as const)
    it.live(`an automatic one waits out '${name}' at its Retry-After, without trading addresses`, () =>
      Effect.gen(function* () {
        const pair = yield* paired
        a.state.answer = answer
        b.state.answer = answer
        const compaction = yield* SessionCompaction.Service
        const context = yield* chat(`auto_${name.replaceAll(" ", "_")}`)
        const fiber = yield* compaction
          .compact({ reason: "auto", context, estimate: { measured: 190_000, estimated: 0 } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.promise(() => Bun.sleep(1_000))
        // One request, or one at each address for CPP down's single move; then the wait of 30 s.
        expect(a.state.requests + b.state.requests).toBe(answer === down ? 2 : 1)
        expect(pair.moves).toEqual(answer === down ? [b.root] : [])
        yield* Fiber.interrupt(fiber)
      }),
    )
})
