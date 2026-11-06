import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { ai, AIError, LanguageModel, LLMEvent, ToolFailure, TransportError, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { LLMClient } from "@opencode/ai/route"
import { TestLLM } from "@opencode/ai/testing"
import { Continuity } from "@opencode/schema/continuity"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { SessionContinuity } from "@opencode/core/continuity"
import { SessionRestTable } from "@opencode/core/continuity/sql"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Form } from "@opencode/core/form"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Tool } from "@opencode/core/tool"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { record, succeeded, transcript } from "./fixture/continuity"
import { testEffect } from "./lib/effect"
import { registerToolPlugin } from "./lib/tool"

// One process generation after another over the same database, with one fake model that counts every request.
// Stopping a generation closes its scope, which is what a SIGTERM does to the service.

const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("test") })
const RESTART_NOTICE = "The server restarted while you were working."

/** What the test tools did, across generations. */
const world = {
  echoes: 0,
  deployTarget: "prod",
  deployStarts: 0,
  deploys: 0,
  phase1: 0,
  phase2: 0,
  /** The checkpoint tool has done its first phase. */
  checkpointed: Deferred.makeUnsafe<void>(),
  external: Deferred.makeUnsafe<string>(),
  /** The hold tool runs. */
  holding: Deferred.makeUnsafe<void>(),
}
const reset = () => {
  world.echoes = 0
  world.deployTarget = "prod"
  world.deployStarts = 0
  world.deploys = 0
  world.phase1 = 0
  world.phase2 = 0
  world.checkpointed = Deferred.makeUnsafe<void>()
  world.external = Deferred.makeUnsafe<string>()
  world.holding = Deferred.makeUnsafe<void>()
}

const Checkpoint = Schema.Struct({ token: Schema.String })

const plugins = makeLocationNode({
  name: "test/continuity-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const tools = yield* Tool.Service
      const permission = yield* Permission.Service
      const continuity = yield* SessionContinuity.Service
      const agents = yield* Agent.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(QuestionTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* agents.transform((editor) => {
        for (const id of ["build", "reviewer"]) {
          editor.update(Agent.ID.make(id), (agent) => {
            agent.mode = id === "build" ? "primary" : "subagent"
            agent.permissions.push(
              { action: "*", resource: "*", effect: "allow" },
              { action: "deploy", resource: "*", effect: "ask" },
            )
          })
        }
      })
      yield* tools
        .transform((editor) => {
          editor.add({
            name: "echo",
            description: "Echo",
            options: { codemode: false },
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.sync(() => {
                world.echoes++
                return { output: {}, content: "echoed" }
              }),
          })
          editor.add({
            name: "deploy",
            description: "Deploy after approval",
            options: { codemode: false },
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: (_input, context) =>
              Effect.gen(function* () {
                world.deployStarts++
                yield* permission
                  .assert({
                    action: "deploy",
                    resources: [world.deployTarget],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: "Deploy denied", error })))
                world.deploys++
                return { output: {}, content: `deployed ${world.deployTarget}` }
              }),
          })
          // A tool that keeps its own progress: phase one runs once, a restart hands back its checkpoint.
          editor.add({
            name: "checkpoint",
            description: "Two phases around an external wait",
            options: { codemode: false },
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: (_input, context) =>
              Effect.gen(function* () {
                const resumed = yield* continuity.resumed(context.id)
                const token =
                  resumed === undefined
                    ? `token-${++world.phase1}`
                    : Schema.decodeUnknownSync(Checkpoint)(resumed).token
                yield* Deferred.succeed(world.checkpointed, undefined)
                const result = yield* continuity.wait(context.id, Deferred.await(world.external), { token })
                world.phase2++
                return { output: {}, content: `${token} ${result}` }
              }),
          })
          editor.add({
            name: "hold",
            description: "Busy until the test ends",
            options: { codemode: false },
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Deferred.succeed(world.holding, undefined).pipe(Effect.andThen(Effect.never), Effect.as({ output: {} })),
          })
        })
        .pipe(Effect.orDie)
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Form.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    Tool.node,
    PluginHooks.node,
    SessionContinuity.node,
  ],
})

/** The one model every step calls, of `provider`. */
const fixedModel = (provider = "test") =>
  SessionRunnerModel.node.replace(
    Layer.succeed(SessionRunnerModel.Service, {
      resolve: () =>
        Effect.succeed(
          SessionRunnerModel.resolved(LanguageModel.make({ id: "model", provider, route: OpenAIChat.route }), {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
          }),
        ),
    }),
  )

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  KV.node,
  Session.node,
  SessionExecution.node,
  SessionRestart.node,
  SessionContinuity.node,
  LocationServiceMap.node,
  LayerNodePlatform.llmClient,
])

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Database.node), TestLLM.testLayer(), tempGlobalLayer))

/**
 * Starts a service generation over the shared database; `stop` is the SIGTERM. `wrap` stands between the services and
 * continuity, to hold one of its steps; `provider` is the provider of the model the steps call.
 */
const start = (
  options: {
    readonly paused?: boolean
    readonly wrap?: (continuity: SessionContinuity.Interface) => SessionContinuity.Interface
    readonly provider?: string
  } = {},
) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const llm = yield* TestLLM.Test
    const global = yield* Global.Service
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const wrap = options.wrap
    const continuityNode = SessionContinuity.configured({ paused: options.paused })
    const context = yield* Layer.buildWithScope(
      AppNodeBuilder.build(nodes, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Global.node.replace(Layer.succeed(Global.Service, global)),
        LayerNodePlatform.llmClient.replace(SessionContinuity.llmClient(Layer.succeed(LLMClient.Service, llm))),
        SessionContinuity.node.replace(
          wrap
            ? continuityNode.mapLayer((layer) =>
                Layer.effect(SessionContinuity.Service, Effect.map(SessionContinuity.Service, wrap)).pipe(
                  Layer.provide(layer),
                ),
              )
            : continuityNode,
        ),
        PluginSupervisor.node.replace(plugins),
        offlineModels,
        fixedModel(options.provider),
      ]),
      scope,
    )
    const bus = Context.get(context, Bus.Service)
    const events = yield* record(bus).pipe(Scope.provide(scope))
    const continuity = Context.get(context, SessionContinuity.Service)
    const restart = Context.get(context, SessionRestart.Service)
    // As the server does: the restart sweep runs once the gate is open.
    yield* continuity.awaitOpen.pipe(Effect.andThen(restart.resumeSuspendedSessions), Effect.forkIn(scope))
    const locations = Context.get(context, LocationServiceMap.Service)
    const inLocation = <A, E, R>(location: Location.Ref, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(locations.get(location)))
    return {
      context,
      events,
      continuity,
      sessions: Context.get(context, Session.Service),
      inLocation,
      permission: (location: Location.Ref) => inLocation(location, Permission.Service.use(Effect.succeed)),
      form: (location: Location.Ref) => inLocation(location, Form.Service.use(Effect.succeed)),
      // The server marks the stop before anything closes.
      stop: continuity.stop.pipe(Effect.andThen(Scope.close(scope, Exit.void))),
    }
  })

type Generation = Effect.Success<ReturnType<typeof start>>

const createSession = (generation: Generation) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* generation.sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
      model,
      title: "continuity",
    })
  })

/** A reply that streams its first events, then waits for `release` before the rest. */
const held = (release: Deferred.Deferred<void>, events: ReadonlyArray<LLMEvent>) =>
  Stream.concat(
    Stream.fromIterable(events.slice(0, 1)),
    Stream.fromEffect(Deferred.await(release)).pipe(Stream.flatMap(() => Stream.fromIterable(events.slice(1)))),
  )

const isChild = (request: LLMRequest) => request.http?.headers?.["x-opencode-parent-session-id"] !== undefined

/** Answers the parent Session's requests and its subagent's from separate scripts; gives when each came, in clock time. */
const script = (llm: TestLLM.TestInterface, parent: TestLLM.Response[], child: TestLLM.Response[] = []) =>
  TestClock.testClockWith((clock) => {
    const times: number[] = []
    return llm
      .serve((request) => {
        times.push(clock.currentTimeMillisUnsafe())
        const next = (isChild(request) ? child : parent).shift()
        if (next === undefined) throw new Error(`unexpected ${isChild(request) ? "child" : "parent"} model request`)
        return next
      })
      .pipe(Effect.as(times))
  })

const counts = (llm: TestLLM.TestInterface) =>
  llm.requests().pipe(
    Effect.map((requests) => ({
      parent: requests.filter((request) => !isChild(request)).length,
      child: requests.filter(isChild).length,
    })),
  )

const asked = (generation: Generation, sessionID: Session.ID) =>
  generation.events.waitFor(Permission.Event.Asked, (event) => event.data.sessionID === sessionID)

const transportError = () =>
  new AIError({
    reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
  })

const pausedAndStopped = (generation: Generation) =>
  Effect.gen(function* () {
    const result = yield* generation.continuity.pause()
    expect(result.paused).toBe(true)
    yield* generation.stop
    return result
  })

/** Holds a generation's first lookup of a stored request until `release`, once it has signalled `lookup`. */
const holdLookup =
  (lookup: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (continuity: SessionContinuity.Interface): SessionContinuity.Interface => ({
    ...continuity,
    requests: {
      ...continuity.requests,
      find: (kind, source) =>
        Deferred.succeed(lookup, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(continuity.requests.find(kind, source)),
        ),
    },
  })

const question = {
  questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Go on" }] }],
}

describe("SessionContinuity", () => {
  it.effect("a reply mid-stream finishes before the pause, and the stop then cuts nothing off", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const release = yield* Deferred.make<void>()
      yield* script(llm, [held(release, TestLLM.toolCall("call_echo", "echo", {})), TestLLM.text("all done", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "work" })
      yield* llm.wait(1)

      const pause = yield* first.continuity.pause().pipe(Effect.forkChild({ startImmediately: true }))
      const pausing = yield* first.continuity.status
      expect(pausing.state).toBe("pausing")
      expect(pausing.waiting.map((work) => work.sessionID)).toContain(session.id)

      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(pause)
      // The reply finished; its tool call did not start and waits for the next process.
      expect(result).toEqual({ paused: true, rested: [session.id] })
      expect(world.echoes).toBe(0)
      yield* first.stop

      const second = yield* start({ paused: true })
      expect(second.continuity.refusesWrites()).toBe(true)
      expect((yield* second.continuity.status).startedPaused).toBe(true)
      yield* second.continuity.resume
      expect(second.continuity.refusesWrites()).toBe(false)
      yield* succeeded(second.events, session.id)

      expect(world.echoes).toBe(1)
      // The same requests as without the stop.
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      const text = yield* transcript(second.sessions, session.id)
      expect(text).not.toContain(RESTART_NOTICE)
      expect(text).toContain("all done")
    }),
  )

  it.effect("a retry wait keeps its remaining time and attempt count across a stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const requested = yield* script(llm, [
        TestLLM.failAfter(transportError()),
        TestLLM.failAfter(transportError()),
        TestLLM.text("recovered", "t1"),
      ])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "work" })
      const scheduled = yield* first.events.waitFor(SessionEvent.RetryScheduled)
      expect(scheduled.data.attempt).toBe(2)
      // A retry wait rests: the pause completes without waiting for it.
      yield* pausedAndStopped(first)

      // Down for a while: the next process waits only what is left of the deadline.
      yield* TestClock.adjust("500 millis")
      const second = yield* start()
      const shown = yield* second.events.waitFor(SessionEvent.RetryScheduled)
      expect(shown.data).toMatchObject({ attempt: 2, at: scheduled.data.at })
      yield* TestClock.setTime(scheduled.data.at)
      yield* llm.wait(2)
      // At the stored deadline, not a whole delay after the restart.
      expect(requested[1]).toBe(scheduled.data.at)

      // The count goes on from the stored attempt.
      const next = yield* second.events.waitFor(SessionEvent.RetryScheduled, (event) => event.data.attempt !== 2)
      expect(next.data.attempt).toBe(3)
      yield* TestClock.setTime(next.data.at)
      yield* succeeded(second.events, session.id)
      expect(yield* counts(llm)).toEqual({ parent: 3, child: 0 })
      expect(yield* transcript(second.sessions, session.id)).not.toContain(RESTART_NOTICE)
    }),
  )

  it.effect("a retry rest an earlier release stored, without an outage's start, decodes; one with it keeps it", () =>
    Effect.gen(function* () {
      reset()
      const db = (yield* Database.Service).db
      const generation = yield* start()
      const session = yield* createSession(generation)
      const rest = {
        kind: "retry",
        step: 1,
        assistantMessageID: SessionMessage.ID.create(),
        mode: "retry",
        attempt: 3,
        timeouts: 0,
        at: 5_000,
        error: { type: "provider.transport", message: "Provider unavailable" },
      } as const
      yield* db
        .insert(SessionRestTable)
        .values({ session_id: session.id, call_id: "", data: rest })
        .run()
        .pipe(Effect.orDie)
      expect((yield* generation.continuity.restored(session.id)).rest).toEqual(rest)
      yield* generation.continuity.save(session.id, { ...rest, outageSince: 1_000 })
      expect((yield* generation.continuity.restored(session.id)).rest).toEqual({ ...rest, outageSince: 1_000 })
    }),
  )

  it.effect("a step in a CPP outage keeps its 30 minutes across a stop, counted from its first failure", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const requested = yield* TestClock.testClockWith((clock) => {
        const times: number[] = []
        return llm
          .serve(() => {
            times.push(clock.currentTimeMillisUnsafe())
            return TestLLM.failAfter(transportError())
          })
          .pipe(Effect.as(times))
      })

      const first = yield* start({ provider: "cliproxypacer" })
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "work" })
      yield* first.events.waitFor(SessionEvent.RetryScheduled)
      // The step's rest says when the run of outages began: at its first failure.
      expect((yield* first.continuity.restored(session.id)).rest).toMatchObject({
        kind: "retry",
        attempt: 2,
        outageSince: requested[0],
      })
      yield* pausedAndStopped(first)

      // Down for 20 minutes; the next process tries again at each deadline until the step stops retrying.
      yield* TestClock.adjust("20 minutes")
      const second = yield* start({ provider: "cliproxypacer" })
      for (let attempt = 2; ; ) {
        const next = yield* Effect.raceFirst(
          second.events.waitFor(SessionEvent.RetryScheduled, (event) => event.data.attempt > attempt),
          second.events.waitFor(SessionEvent.Execution.Failed, (event) => event.data.sessionID === session.id),
        )
        if (next.type === SessionEvent.Execution.Failed.type) break
        attempt = next.data.attempt
        yield* TestClock.setTime(next.data.at)
      }
      // The last try came at 30 minutes from the first failure or within a gap after; the one before, before them.
      const since = (index: number) => (requested.at(index) ?? Number.NaN) - requested[0]
      expect(since(-2)).toBeLessThan(30 * 60_000)
      expect(since(-1)).toBeGreaterThanOrEqual(30 * 60_000)
      expect(since(-1) - since(-2)).toBeLessThanOrEqual(12_000)
    }),
  )

  it.effect("a permission request is shown again with the same id and the tool runs again", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_deploy", "deploy", {}), TestLLM.text("deployed", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "deploy" })
      const before = yield* asked(first, session.id)
      yield* pausedAndStopped(first)

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      const again = yield* asked(second, session.id)
      expect(again.data.id).toBe(before.data.id)
      expect(world.deployStarts).toBe(2)
      const permission = yield* second.permission(session.location)
      expect((yield* permission.list()).map((request) => request.id)).toEqual([before.data.id])
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      // A client resending its answer gets the same success.
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      yield* succeeded(second.events, session.id)

      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second.sessions, session.id)).not.toContain(RESTART_NOTICE)
    }),
  )

  it.effect("an answer given while paused reaches the rerun of the tool after the stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_deploy", "deploy", {}), TestLLM.text("deployed", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "deploy" })
      const before = yield* asked(first, session.id)
      expect((yield* first.continuity.pause()).paused).toBe(true)
      const permission = yield* first.permission(session.location)
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      // The tool holds the answer until the gate opens.
      expect(world.deploys).toBe(0)
      yield* first.stop

      const second = yield* start()
      yield* succeeded(second.events, session.id)
      expect(second.events.of(Permission.Event.Asked)).toEqual([])
      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
    }),
  )

  // As an answer resent through a release switch can arrive: just as the rerun takes the stored request.
  it.effect("an answer that arrives while the rerun takes its stored request reaches the tool", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_deploy", "deploy", {}), TestLLM.text("deployed", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "deploy" })
      const before = yield* asked(first, session.id)
      yield* pausedAndStopped(first)

      const lookup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const second = yield* start({ wrap: holdLookup(lookup, release) })
      const permission = yield* second.permission(session.location)
      yield* Deferred.await(lookup)
      const reply = yield* permission
        .reply({ requestID: before.data.id, reply: "once" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(reply)
      // The answer went to the request the rerun asked again, not only to the stored one.
      expect(yield* permission.list()).toEqual([])
      yield* succeeded(second.events, session.id)
      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
    }),
  )

  it.effect("a rerun that asks something else gets a new request", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_deploy", "deploy", {}), TestLLM.text("deployed", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "deploy" })
      const before = yield* asked(first, session.id)
      yield* pausedAndStopped(first)

      world.deployTarget = "staging"
      const second = yield* start()
      const again = yield* asked(second, session.id)
      expect(again.data.id).not.toBe(before.data.id)
      expect(again.data.resources).toEqual(["staging"])
      const permission = yield* second.permission(session.location)
      const stale = yield* permission.reply({ requestID: before.data.id, reply: "once" }).pipe(Effect.flip)
      expect(stale._tag).toBe("Permission.NotFoundError")
      yield* permission.reply({ requestID: again.data.id, reply: "once" })
      yield* succeeded(second.events, session.id)
      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
    }),
  )

  it.effect("a question is shown again with the same id and its answer reaches the tool", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_question", "question", question), TestLLM.text("thanks", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "ask me" })
      const before = yield* first.events.waitFor(Form.Event.Created)
      yield* pausedAndStopped(first)

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      const again = yield* second.events.waitFor(Form.Event.Created)
      expect(again.data.form.id).toBe(before.data.form.id)
      const form = yield* second.form(session.location)
      yield* form.reply({ id: before.data.form.id, answer: { q0: "Yes" } })
      yield* form.reply({ id: before.data.form.id, answer: { q0: "Yes" } })
      yield* succeeded(second.events, session.id)

      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      const text = yield* transcript(second.sessions, session.id)
      expect(text).toContain(`\\"Continue?\\"=\\"Yes\\"`)
      expect(text).not.toContain(RESTART_NOTICE)
    }),
  )

  it.effect("a question dismissed while paused stays dismissed for the rerun after the stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_question", "question", question)])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "ask me" })
      const before = yield* first.events.waitFor(Form.Event.Created)
      expect((yield* first.continuity.pause()).paused).toBe(true)
      const form = yield* first.form(session.location)
      yield* form.cancel(before.data.form.id)
      yield* first.stop

      const second = yield* start()
      yield* Effect.raceFirst(
        second.events.waitFor(Form.Event.Created),
        second.events.waitFor(SessionEvent.Execution.Interrupted, (event) => event.data.sessionID === session.id),
      )
      // The rerun found it dismissed: nothing was asked, and the turn ends as a dismissal does.
      expect(second.events.of(Form.Event.Created)).toEqual([])
      expect(yield* transcript(second.sessions, session.id)).toContain("The user dismissed this question")
      expect(yield* counts(llm)).toEqual({ parent: 1, child: 0 })
    }),
  )

  // As an answer resent through a release switch arrives: the new release runs, its tool has not asked again yet.
  it.effect("an answer to a question that arrives before its tool asks again reaches the rerun", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_question", "question", question), TestLLM.text("thanks", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "ask me" })
      const before = yield* first.events.waitFor(Form.Event.Created)
      yield* pausedAndStopped(first)

      const second = yield* start({ paused: true })
      const form = yield* second.form(session.location)
      expect(yield* form.list()).toEqual([])
      const elsewhere = yield* form
        .reply({ id: before.data.form.id, answer: { q0: "Yes" }, sessionID: "ses_someone_else" })
        .pipe(Effect.flip)
      expect(elsewhere._tag).toBe("Form.NotFoundError")
      yield* form.reply({ id: before.data.form.id, answer: { q0: "Yes" }, sessionID: session.id })
      // The same answer again, as a client resends it, gets the same success.
      yield* form.reply({ id: before.data.form.id, answer: { q0: "Yes" }, sessionID: session.id })
      yield* second.continuity.resume
      yield* succeeded(second.events, session.id)

      // The rerun found its answer and asked nothing.
      expect(second.events.of(Form.Event.Created)).toEqual([])
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second.sessions, session.id)).toContain(`\\"Continue?\\"=\\"Yes\\"`)
    }),
  )

  // As a dismissal resent through a release switch arrives: the new release runs, its tool has not asked again yet.
  it.effect("a question dismissed before its tool asks again is not asked again", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_question", "question", question)])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "ask me" })
      const before = yield* first.events.waitFor(Form.Event.Created)
      yield* pausedAndStopped(first)

      const second = yield* start({ paused: true })
      const form = yield* second.form(session.location)
      const id = before.data.form.id
      expect((yield* form.cancel(id, { sessionID: "ses_someone_else" }).pipe(Effect.flip))._tag).toBe(
        "Form.NotFoundError",
      )
      yield* form.cancel(id, { sessionID: session.id })
      // The same dismissal again, as a client resends it, gets the same success; an answer after it is too late.
      yield* form.cancel(id, { sessionID: session.id })
      expect((yield* form.reply({ id, answer: { q0: "Yes" }, sessionID: session.id }).pipe(Effect.flip))._tag).toBe(
        "Form.AlreadySettledError",
      )
      expect(second.events.of(Form.Event.Cancelled).map((event) => event.data)).toEqual([{ id, sessionID: session.id }])
      yield* second.continuity.resume
      yield* second.events.waitFor(SessionEvent.Execution.Interrupted, (event) => event.data.sessionID === session.id)

      // The rerun found it dismissed: nothing was asked, and the turn ends as a dismissal does.
      expect(second.events.of(Form.Event.Created)).toEqual([])
      expect(yield* form.list()).toEqual([])
      expect(yield* counts(llm)).toEqual({ parent: 1, child: 0 })
      expect(yield* transcript(second.sessions, session.id)).toContain("The user dismissed this question")
      // Cancelled once the rerun took it: the same dismissal still succeeds.
      yield* form.cancel(id, { sessionID: session.id })
    }),
  )

  it.effect("a question dismissed after its tool asked again is dismissed once", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_question", "question", question)])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "ask me" })
      const before = yield* first.events.waitFor(Form.Event.Created)
      yield* pausedAndStopped(first)

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      yield* second.events.waitFor(Form.Event.Created)
      const form = yield* second.form(session.location)
      yield* form.cancel(before.data.form.id, { sessionID: session.id })
      yield* form.cancel(before.data.form.id, { sessionID: session.id })
      yield* second.events.waitFor(SessionEvent.Execution.Interrupted, (event) => event.data.sessionID === session.id)
      expect(second.events.of(Form.Event.Cancelled)).toHaveLength(1)
      expect(yield* counts(llm)).toEqual({ parent: 1, child: 0 })
    }),
  )

  it.effect("a foreground subagent call waits for the same child again after the stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const db = (yield* Database.Service).db
      yield* script(
        llm,
        [
          TestLLM.toolCall("call_sub", "subagent", { agent: "reviewer", description: "review", prompt: "check it" }),
          TestLLM.text("parent done", "p2"),
        ],
        [TestLLM.toolCall("call_child_deploy", "deploy", {}), TestLLM.text("child done", "c2")],
      )

      const first = yield* start()
      const parent = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: parent.id, text: "delegate" })
      const before = yield* first.events.waitFor(Permission.Event.Asked)
      const child = before.data.sessionID
      const result = yield* pausedAndStopped(first)
      expect(new Set(result.paused ? result.rested : [])).toEqual(new Set([parent.id, child]))

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      const again = yield* asked(second, child)
      expect(again.data.id).toBe(before.data.id)
      const permission = yield* second.permission(parent.location)
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      yield* succeeded(second.events, parent.id)

      const children = yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, parent.id)).all()
      expect(children.map((row) => row.id)).toEqual([child])
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 2 })
      const text = yield* transcript(second.sessions, parent.id)
      expect(text).toContain("child done")
      expect(text).toContain("parent done")
      expect(text).not.toContain(RESTART_NOTICE)
      expect(yield* transcript(second.sessions, child)).not.toContain(RESTART_NOTICE)
    }),
  )

  it.effect("a background subagent continues after the stop and is never reported cancelled", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(
        llm,
        [
          TestLLM.toolCall("call_sub", "subagent", {
            agent: "reviewer",
            description: "review",
            prompt: "check it",
            background: true,
          }),
          TestLLM.text("started it", "p2"),
          TestLLM.text("noted", "p3"),
        ],
        [TestLLM.toolCall("call_child_deploy", "deploy", {}), TestLLM.text("child done", "c2")],
      )

      const first = yield* start()
      const parent = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: parent.id, text: "delegate" })
      const before = yield* first.events.waitFor(Permission.Event.Asked)
      const child = before.data.sessionID
      yield* succeeded(first.events, parent.id)
      yield* pausedAndStopped(first)
      expect(yield* transcript(first.sessions, parent.id)).not.toContain("cancelled")

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      const again = yield* asked(second, child)
      expect(again.data.id).toBe(before.data.id)
      const permission = yield* second.permission(parent.location)
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      yield* second.events.waitFor(SessionEvent.Execution.Succeeded, (event) => event.data.sessionID === child)
      yield* succeeded(second.events, parent.id)

      expect(yield* counts(llm)).toEqual({ parent: 3, child: 2 })
      const text = yield* transcript(second.sessions, parent.id)
      expect(text).toContain(`state=\\"completed\\"`)
      expect(text).toContain("child done")
      expect(text).not.toContain("cancelled")
    }),
  )

  it.effect("prompts queued during the pause run in order after the stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const release = yield* Deferred.make<void>()
      yield* script(llm, [
        held(release, TestLLM.text("answer A", "a")),
        TestLLM.text("answer B", "b"),
        TestLLM.text("answer C", "c"),
      ])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "prompt A" })
      yield* llm.wait(1)
      const pause = yield* first.continuity.pause().pipe(Effect.forkChild({ startImmediately: true }))
      yield* first.sessions.prompt({ sessionID: session.id, text: "prompt B", delivery: "queue" })
      yield* first.sessions.prompt({ sessionID: session.id, text: "prompt C", delivery: "queue" })
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(pause)).paused).toBe(true)
      expect((yield* counts(llm)).parent).toBe(1)
      yield* first.stop

      const second = yield* start()
      yield* succeeded(second.events, session.id)
      const requests = (yield* llm.requests()).map((request) => JSON.stringify(request.messages))
      expect(requests).toHaveLength(3)
      expect(requests[1]).toContain("prompt B")
      expect(requests[1]).not.toContain("prompt C")
      expect(requests[2]).toContain("prompt C")
      expect(yield* transcript(second.sessions, session.id)).not.toContain(RESTART_NOTICE)
    }),
  )

  it.effect("a prompt resent with the same id after the stop is ignored", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.text("hello back", "t1")])
      const id = SessionMessage.ID.create()

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, id, text: "hello" })
      yield* succeeded(first.events, session.id)
      yield* pausedAndStopped(first)

      const second = yield* start()
      yield* second.sessions.prompt({ sessionID: session.id, id, text: "hello" })
      yield* second.sessions.wait(session.id)
      expect(yield* counts(llm)).toEqual({ parent: 1, child: 0 })
      const users = (yield* second.sessions.messages({ sessionID: session.id })).filter(
        (message) => message.type === "user",
      )
      expect(users).toHaveLength(1)
    }),
  )

  it.effect("a tool keeps its own checkpoint across the stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_checkpoint", "checkpoint", {}), TestLLM.text("done", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "work" })
      yield* Deferred.await(world.checkpointed)
      yield* pausedAndStopped(first)

      const second = yield* start()
      yield* Deferred.succeed(world.external, "resumed")
      yield* succeeded(second.events, session.id)
      // Phase one ran once; the rerun took its token from the checkpoint.
      expect(world.phase1).toBe(1)
      expect(world.phase2).toBe(1)
      expect(yield* transcript(second.sessions, session.id)).toContain("token-1 resumed")
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
    }),
  )

  it.effect("a pause gives up after its limit and reopens the gate", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_hold", "hold", {})])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "work" })
      yield* Deferred.await(world.holding)

      const pause = yield* first.continuity.pause({ timeout: 1_000 }).pipe(Effect.forkChild({ startImmediately: true }))
      expect((yield* first.continuity.status).waiting).toEqual([{ sessionID: session.id, kind: "tool", name: "hold" }])
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(pause)).toEqual({
        paused: false,
        waiting: [{ sessionID: session.id, kind: "tool", name: "hold" }],
      })
      expect((yield* first.continuity.status).state).toBe("running")
      expect(first.events.of(Continuity.Event.Expired)).toHaveLength(1)
      // Open again: work that waits for the gate passes.
      yield* first.continuity.awaitOpen
    }),
  )

  // When a resume and a new pause both land before the earlier pause's loop runs again.
  it.effect("a pause asked again right after a resume keeps its own limit", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const services = yield* Layer.build(
        LayerNode.compile(LayerNode.group([Bus.node, KV.node]), {
          replacements: [Database.node.replace(Layer.succeed(Database.Service, database))],
        }),
      )
      const bus = Context.get(services, Bus.Service)
      const publishing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let held = false
      // The earlier pause's loop stays in its first notice until the resume and the later pause are in.
      const holding: Bus.Interface = {
        ...bus,
        publish: (definition, data, options) =>
          (definition.type !== Continuity.Event.Pausing.type || held
            ? Effect.void
            : Effect.sync(() => {
                held = true
              }).pipe(Effect.andThen(Deferred.succeed(publishing, undefined)), Effect.andThen(Deferred.await(release)))
          ).pipe(Effect.andThen(bus.publish(definition, data, options))),
      }
      const continuity = Context.get(
        yield* Layer.build(
          SessionContinuity.layer().pipe(
            Layer.provide(Layer.succeed(Bus.Service, holding)),
            Layer.provide(Layer.succeedContext(services)),
          ),
        ),
        SessionContinuity.Service,
      )
      const sessionID = Session.ID.create()
      const activity = continuity.activity(sessionID)
      activity.attempt()
      activity.register({ id: "call_hold", name: "hold", messageID: SessionMessage.ID.create(), survives: true })

      const earlier = yield* continuity.pause({ timeout: 1_000 }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(publishing)
      yield* continuity.resume
      const later = yield* continuity.pause({ timeout: 5_000 }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      // The earlier pause ended with the resume; its limit does not end the later one.
      yield* TestClock.adjust("1 second")
      expect((yield* continuity.status).state).toBe("pausing")
      expect(yield* Fiber.join(earlier)).toMatchObject({ paused: false })
      yield* TestClock.adjust("4 seconds")
      expect(yield* Fiber.join(later)).toEqual({ paused: false, waiting: [{ sessionID, kind: "tool", name: "hold" }] })
    }),
  )

  // Such as a title, a plugin's own call, or a compaction that runs on its own.
  it.effect("a model call outside a turn holds a pause until it ends, and waits while paused", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      const release = yield* Deferred.make<void>()
      yield* script(llm, [held(release, TestLLM.text("first", "t1")), TestLLM.text("second", "t2")])
      const request = ai.request({
        model: LanguageModel.make({ id: "model", provider: "test", route: OpenAIChat.route }),
        prompt: "name this chat",
      })

      const first = yield* start()
      const client = Context.get(first.context, LLMClient.Service)
      const running = yield* client.generate(request).pipe(Effect.forkChild({ startImmediately: true }))
      yield* llm.wait(1)
      const pause = yield* first.continuity.pause().pipe(Effect.forkChild({ startImmediately: true }))
      expect((yield* first.continuity.status).waiting).toEqual([{ kind: "model", name: "model" }])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(yield* Fiber.join(pause)).toEqual({ paused: true, rested: [] })

      const waiting = yield* client.generate(request).pipe(Effect.forkChild({ startImmediately: true }))
      expect(yield* counts(llm)).toEqual({ parent: 1, child: 0 })
      yield* first.continuity.resume
      yield* Fiber.join(waiting)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
    }),
  )

  it.effect("a stop without a pause still resumes the turn, with the restart notice", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [TestLLM.toolCall("call_deploy", "deploy", {}), TestLLM.text("deployed", "t1")])

      const first = yield* start()
      const session = yield* createSession(first)
      yield* first.sessions.prompt({ sessionID: session.id, text: "deploy" })
      const before = yield* asked(first, session.id)
      yield* first.stop

      const second = yield* start()
      const again = yield* asked(second, session.id)
      expect(again.data.id).toBe(before.data.id)
      const permission = yield* second.permission(session.location)
      yield* permission.reply({ requestID: before.data.id, reply: "once" })
      yield* succeeded(second.events, session.id)
      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second.sessions, session.id)).toContain(RESTART_NOTICE)
    }),
  )
})
