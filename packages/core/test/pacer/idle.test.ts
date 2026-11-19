import { describe, expect } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Scope, SubscriptionRef } from "effect"
import { AIError, InvalidRequestError, LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { LLMClient } from "@opencode/ai/route"
import { TestLLM } from "@opencode/ai/testing"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { SessionContinuity } from "@opencode/core/continuity"
import { ServiceClient } from "@opencode/core/service-client"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerIdle } from "@opencode/core/pacer/idle"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { record } from "../fixture/continuity"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { catalogOf, endpointAt, key } from "../memory/fixture"

// openforge's idle notice (workspace reference `docs/reference/goals-board-api.md`, "openforge's idle notice") through
// the real session service, execution and runner: a fake CPP records each `POST /pacer/v1/chats/idle`, and can hold its
// answer forever to show the chat never waits on it.

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Database.node), TestLLM.testLayer(), tempGlobalLayer))

interface Notice {
  readonly session: string | null
  readonly parent: string | null
  readonly authorization: string | null
  readonly body: unknown
}

const fakeCpp = Effect.acquireRelease(
  Effect.sync(() => {
    const notices: Notice[] = []
    const state = { hang: false }
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method !== "POST" || url.pathname !== PacerIdle.PATH)
          return new Response("404 page not found", { status: 404 })
        notices.push({
          session: request.headers.get("x-pacer-session"),
          parent: request.headers.get("x-pacer-parent-session"),
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        })
        if (state.hang) await new Promise(() => {})
        return new Response(null, { status: 204 })
      },
    })
    return { origin: `http://127.0.0.1:${server.port}`, notices, state, server }
  }),
  (cpp) => Effect.promise(() => cpp.server.stop(true)),
)

/** The chat's agent, as openforge's plugins leave it. */
const agents = makeLocationNode({
  name: "test/pacer-idle-agents",
  layer: Layer.effectDiscard(
    Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ),
  ),
  deps: [Agent.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  KV.node,
  Session.node,
  SessionExecution.node,
  SessionContinuity.node,
  LocationServiceMap.node,
  LayerNodePlatform.llmClient,
  PacerIdle.node,
])

/** The services over the shared database, with CPP at `origin` and the chat's model of `provider`. */
const start = (input: { readonly origin: string; readonly provider: string; readonly catalog: PacerModels.Catalog }) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const llm = yield* TestLLM.Test
    const global = yield* Global.Service
    const endpoint = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(input.origin))
    const catalog = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(input.catalog)
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const context = yield* Layer.buildWithScope(
      AppNodeBuilder.build(nodes, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Global.node.replace(Layer.succeed(Global.Service, global)),
        LayerNodePlatform.llmClient.replace(ServiceClient.llm(Layer.succeed(LLMClient.Service, llm))),
        PluginSupervisor.node.replace(agents),
        offlineModels,
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "model", provider: input.provider, route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
        PacerEndpoint.node.replace(
          Layer.succeed(
            PacerEndpoint.Service,
            PacerEndpoint.Service.of({
              get: () => SubscriptionRef.get(endpoint),
              changes: () => SubscriptionRef.changes(endpoint),
            }),
          ),
        ),
        PacerModels.node.replace(
          Layer.succeed(
            PacerModels.Service,
            PacerModels.Service.of({
              get: () => SubscriptionRef.get(catalog),
              changes: () => SubscriptionRef.changes(catalog),
              refresh: () => Effect.void,
            }),
          ),
        ),
      ]),
      scope,
    )
    const events = yield* record(Context.get(context, Bus.Service)).pipe(Scope.provide(scope))
    const sessions = Context.get(context, Session.Service)
    const dir = yield* tmpdirScoped()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make(input.provider) })
    const create = (parentID?: Session.ID) =>
      parentID
        ? sessions.create({ parentID, model, title: "idle" })
        : sessions.create({ location, model, title: "idle" })
    return { llm, events, sessions, create }
  })

/** CPP's answers for this fake server: it has no tools list, only the idle notice's route answers. */
const goals = () => catalogOf(true, { goals: true, tools: false })
const cppModel = "cliproxypacer"

/** Waits until `count` notices arrived, at most 5 seconds. */
const arrived = (notices: ReadonlyArray<Notice>, count: number) =>
  Effect.gen(function* () {
    for (let waited = 0; notices.length < count; waited += 10) {
      if (waited > 5_000) throw new Error(`${notices.length} notices arrived, not ${count}`)
      yield* Effect.promise(() => Bun.sleep(10))
    }
  })

/** Lets anything a chat's end would send arrive. */
const settle = Effect.promise(() => Bun.sleep(300))

/** The start of an answer: a text part that has begun. */
const begun = (id: string) => [LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text: "Working" })]

const invalid = () => new AIError({ reason: new InvalidRequestError({ message: "Invalid request" }) })

describe("the idle notice", () => {
  it.live(
    "a turn that ended, a stop by the person and a failure each send one, in the chat's name, with the time",
    () =>
      Effect.gen(function* () {
        const cpp = yield* fakeCpp
        const h = yield* start({ origin: cpp.origin, provider: cppModel, catalog: goals() })
        const chat = yield* h.create()
        const expected = (at: { readonly before: number; readonly after: number }) => {
          const notice = cpp.notices.at(-1)!
          expect(notice).toMatchObject({
            session: PacerSessionID.make(chat.id),
            parent: null,
            authorization: `Bearer ${key}`,
          })
          expect(Object.keys(notice.body as object)).toEqual(["at"])
          const sent = (notice.body as { at: number }).at
          expect(sent).toBeGreaterThanOrEqual(at.before)
          expect(sent).toBeLessThanOrEqual(at.after)
        }

        // A turn that ended.
        let before = Date.now()
        yield* h.llm.push(TestLLM.text("Done.", "done"))
        yield* h.sessions.prompt({ sessionID: chat.id, text: "hello", resume: false })
        yield* h.sessions.resume(chat.id)
        yield* arrived(cpp.notices, 1)
        expected({ before, after: Date.now() })

        // The person stopped it, mid-answer.
        before = Date.now()
        yield* h.llm.push(TestLLM.hangAfter(...begun("working")))
        yield* h.sessions.prompt({ sessionID: chat.id, text: "go on", resume: false })
        const steps = h.events.of(SessionEvent.Step.Started).length
        const running = yield* h.sessions.resume(chat.id).pipe(Effect.exit, Effect.forkChild)
        while (h.events.of(SessionEvent.Step.Started).length === steps) yield* Effect.promise(() => Bun.sleep(5))
        expect(yield* h.sessions.interrupt(chat.id)).toBe(true)
        yield* Fiber.await(running)
        yield* arrived(cpp.notices, 2)
        expected({ before, after: Date.now() })
        expect(
          h.events.of(SessionEvent.Execution.Interrupted).map((event) => [event.data.sessionID, event.data.reason]),
        ).toEqual([[chat.id, "user"]])

        // It failed.
        before = Date.now()
        yield* h.llm.push(TestLLM.failAfter(invalid(), ...begun("partial")))
        yield* h.sessions.prompt({ sessionID: chat.id, text: "once more", resume: false })
        expect((yield* h.sessions.resume(chat.id).pipe(Effect.exit))._tag).toBe("Failure")
        yield* arrived(cpp.notices, 3)
        expected({ before, after: Date.now() })
        expect(h.events.of(SessionEvent.Execution.Failed)).toHaveLength(1)

        yield* settle
        expect(cpp.notices).toHaveLength(3)
      }),
  )

  it.live("a subagent's chat sends its own, by its own id", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const h = yield* start({ origin: cpp.origin, provider: cppModel, catalog: goals() })
      const lead = yield* h.create()
      const child = yield* h.create(lead.id)
      yield* h.llm.push(TestLLM.text("Found it.", "found"))
      yield* h.sessions.prompt({ sessionID: child.id, text: "look", resume: false })
      yield* h.sessions.resume(child.id)
      yield* arrived(cpp.notices, 1)
      expect(cpp.notices[0]?.session).toBe(PacerSessionID.make(child.id))
      yield* settle
      expect(cpp.notices).toHaveLength(1)
    }),
  )

  it.live("none off CLIProxyPacer, none when its capabilities lack goals", () =>
    Effect.gen(function* () {
      for (const input of [
        { provider: "anthropic", catalog: goals() },
        { provider: cppModel, catalog: catalogOf(true) },
        { provider: cppModel, catalog: catalogOf(false) },
        { provider: cppModel, catalog: catalogOf("no pacer") },
      ]) {
        const cpp = yield* fakeCpp
        const h = yield* start({ origin: cpp.origin, ...input })
        const chat = yield* h.create()
        yield* h.llm.push(TestLLM.text("Done.", "done"))
        yield* h.sessions.prompt({ sessionID: chat.id, text: "hello", resume: false })
        yield* h.sessions.resume(chat.id)
        yield* settle
        expect({ ...input, sent: cpp.notices.length }).toEqual({ ...input, sent: 0 })
      }
    }),
  )

  it.live("is never waited on: with CPP holding its answer, the chat goes idle and runs its next turn", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      cpp.state.hang = true
      const h = yield* start({ origin: cpp.origin, provider: cppModel, catalog: goals() })
      const chat = yield* h.create()
      for (const turn of ["one", "two"]) {
        yield* h.llm.push(TestLLM.text("Done.", `done-${turn}`))
        yield* h.sessions.prompt({ sessionID: chat.id, text: `turn ${turn}`, resume: false })
        const started = Date.now()
        yield* h.sessions.resume(chat.id)
        yield* h.sessions.wait(chat.id)
        expect(Date.now() - started).toBeLessThan(2_000)
      }
      // Both notices went out and are still unanswered.
      yield* arrived(cpp.notices, 2)
      expect(h.events.of(SessionEvent.Execution.Succeeded)).toHaveLength(2)
    }),
  )
})
