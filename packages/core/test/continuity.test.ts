import { describe, expect } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { AIError, LanguageModel, LLMEvent, ToolFailure, TransportError, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { LLMClient } from "@opencode/ai/route"
import { TestLLM } from "@opencode/ai/testing"
import { Continuity } from "@opencode/schema/continuity"
import type { Event } from "@opencode/schema/event"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { SessionContinuity } from "@opencode/core/continuity"
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
  external: Deferred.makeUnsafe<string>(),
  holds: 0,
}
const reset = () => {
  world.echoes = 0
  world.deployTarget = "prod"
  world.deployStarts = 0
  world.deploys = 0
  world.phase1 = 0
  world.phase2 = 0
  world.external = Deferred.makeUnsafe<string>()
  world.holds = 0
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
              Effect.sync(() => world.holds++).pipe(Effect.andThen(Effect.never), Effect.as({ output: {} })),
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

const fixedModel = SessionRunnerModel.node.replace(
  Layer.succeed(SessionRunnerModel.Service, {
    resolve: () =>
      Effect.succeed(
        SessionRunnerModel.resolved(LanguageModel.make({ id: "model", provider: "test", route: OpenAIChat.route }), {
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
])

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Database.node), TestLLM.testLayer(), tempGlobalLayer))

/** Every event a generation published, and a way to wait for one. */
const record = (bus: Bus.Interface) =>
  Effect.gen(function* () {
    const events: Event.Payload[] = []
    let signal = Deferred.makeUnsafe<void>()
    yield* bus.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event)
          const previous = signal
          signal = Deferred.makeUnsafe()
          Deferred.doneUnsafe(previous, Exit.void)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const of = <D extends Event.Definition>(definition: D) =>
      events.filter((event): event is Event.Payload<D> => event.type === definition.type)
    const waitFor = <D extends Event.Definition>(
      definition: D,
      predicate: (event: Event.Payload<D>) => boolean = () => true,
    ): Effect.Effect<Event.Payload<D>> =>
      Effect.suspend(() => {
        const found = of(definition).find(predicate)
        if (found) return Effect.succeed(found)
        return Deferred.await(signal).pipe(Effect.andThen(waitFor(definition, predicate)))
      })
    return { events, of, waitFor }
  })

/**
 * Starts a service generation over the shared database; `stop` is the SIGTERM. `wrap` stands between the services and
 * continuity, to hold one of its steps.
 */
const start = (
  options: {
    readonly paused?: boolean
    readonly wrap?: (continuity: SessionContinuity.Interface) => SessionContinuity.Interface
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
        LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
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
        fixedModel,
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

const succeeded = (generation: Generation, sessionID: Session.ID) =>
  generation.events.waitFor(SessionEvent.Execution.Succeeded, (event) => event.data.sessionID === sessionID)

const transcript = (generation: Generation, sessionID: Session.ID) =>
  generation.sessions.messages({ sessionID }).pipe(Effect.map((messages) => JSON.stringify(messages)))

/** A reply that streams its first events, then waits for `release` before the rest. */
const held = (release: Deferred.Deferred<void>, events: ReadonlyArray<LLMEvent>) =>
  Stream.concat(
    Stream.fromIterable(events.slice(0, 1)),
    Stream.fromEffect(Deferred.await(release)).pipe(Stream.flatMap(() => Stream.fromIterable(events.slice(1)))),
  )

const isChild = (request: LLMRequest) => request.http?.headers?.["x-opencode-parent-session-id"] !== undefined

/** Answers the parent Session's requests and its subagent's from separate scripts. */
const script = (llm: TestLLM.TestInterface, parent: TestLLM.Response[], child: TestLLM.Response[] = []) =>
  llm.serve((request) => {
    const next = (isChild(request) ? child : parent).shift()
    if (next === undefined) throw new Error(`unexpected ${isChild(request) ? "child" : "parent"} model request`)
    return next
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

/** Lets pub/sub delivery and fiber hops finish on a real macrotask between TestClock steps. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))

/** Settles real work until `condition` holds, bounded by real time. */
const until = Effect.fnUntraced(function* (condition: () => boolean) {
  const deadline = performance.now() + 10_000
  while (!condition()) {
    if (performance.now() > deadline) return yield* Effect.die(new Error("condition never held within 10s"))
    yield* settle
  }
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
      yield* succeeded(second, session.id)

      expect(world.echoes).toBe(1)
      // The same requests as without the stop.
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      const text = yield* transcript(second, session.id)
      expect(text).not.toContain(RESTART_NOTICE)
      expect(text).toContain("all done")
    }),
  )

  it.effect("a retry wait keeps its remaining time and attempt count across a stop", () =>
    Effect.gen(function* () {
      reset()
      const llm = yield* TestLLM.Test
      yield* script(llm, [
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
      yield* settle
      const now = yield* Clock.currentTimeMillis
      yield* TestClock.adjust(scheduled.data.at - now - 1)
      yield* settle
      expect((yield* counts(llm)).parent).toBe(1)
      yield* TestClock.adjust(1)
      yield* llm.wait(2)

      // The count goes on from the stored attempt.
      const next = yield* second.events.waitFor(SessionEvent.RetryScheduled, (event) => event.data.attempt !== 2)
      expect(next.data.attempt).toBe(3)
      yield* settle
      yield* TestClock.adjust(next.data.at - (yield* Clock.currentTimeMillis))
      yield* succeeded(second, session.id)
      expect(yield* counts(llm)).toEqual({ parent: 3, child: 0 })
      expect(yield* transcript(second, session.id)).not.toContain(RESTART_NOTICE)
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
      yield* succeeded(second, session.id)

      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second, session.id)).not.toContain(RESTART_NOTICE)
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
      yield* (yield* first.permission(session.location)).reply({ requestID: before.data.id, reply: "once" })
      // The tool holds the answer until the gate opens.
      expect(world.deploys).toBe(0)
      yield* first.stop

      const second = yield* start()
      yield* succeeded(second, session.id)
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
      yield* succeeded(second, session.id)
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
      yield* succeeded(second, session.id)
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
      yield* succeeded(second, session.id)

      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      const text = yield* transcript(second, session.id)
      expect(text).toContain(`\\"Continue?\\"=\\"Yes\\"`)
      expect(text).not.toContain(RESTART_NOTICE)
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
      yield* succeeded(second, session.id)

      // The rerun found its answer and asked nothing.
      expect(second.events.of(Form.Event.Created)).toEqual([])
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second, session.id)).toContain(`\\"Continue?\\"=\\"Yes\\"`)
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
      expect(yield* transcript(second, session.id)).toContain("The user dismissed this question")
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
      yield* (yield* second.permission(parent.location)).reply({ requestID: before.data.id, reply: "once" })
      yield* succeeded(second, parent.id)

      const children = yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, parent.id)).all()
      expect(children.map((row) => row.id)).toEqual([child])
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 2 })
      const text = yield* transcript(second, parent.id)
      expect(text).toContain("child done")
      expect(text).toContain("parent done")
      expect(text).not.toContain(RESTART_NOTICE)
      expect(yield* transcript(second, child)).not.toContain(RESTART_NOTICE)
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
      yield* succeeded(first, parent.id)
      yield* pausedAndStopped(first)
      expect(yield* transcript(first, parent.id)).not.toContain("cancelled")

      const second = yield* start({ paused: true })
      yield* second.continuity.resume
      const again = yield* asked(second, child)
      expect(again.data.id).toBe(before.data.id)
      yield* (yield* second.permission(parent.location)).reply({ requestID: before.data.id, reply: "once" })
      yield* second.events.waitFor(SessionEvent.Execution.Succeeded, (event) => event.data.sessionID === child)
      yield* succeeded(second, parent.id)

      expect(yield* counts(llm)).toEqual({ parent: 3, child: 2 })
      const text = yield* transcript(second, parent.id)
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
      yield* succeeded(second, session.id)
      const requests = (yield* llm.requests()).map((request) => JSON.stringify(request.messages))
      expect(requests).toHaveLength(3)
      expect(requests[1]).toContain("prompt B")
      expect(requests[1]).not.toContain("prompt C")
      expect(requests[2]).toContain("prompt C")
      expect(yield* transcript(second, session.id)).not.toContain(RESTART_NOTICE)
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
      yield* succeeded(first, session.id)
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
      yield* until(() => world.phase1 === 1)
      yield* pausedAndStopped(first)

      const second = yield* start()
      yield* settle
      yield* Deferred.succeed(world.external, "resumed")
      yield* succeeded(second, session.id)
      // Phase one ran once; the rerun took its token from the checkpoint.
      expect(world.phase1).toBe(1)
      expect(world.phase2).toBe(1)
      expect(yield* transcript(second, session.id)).toContain("token-1 resumed")
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
      yield* until(() => world.holds === 1)

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
      yield* (yield* second.permission(session.location)).reply({ requestID: before.data.id, reply: "once" })
      yield* succeeded(second, session.id)
      expect(world.deploys).toBe(1)
      expect(yield* counts(llm)).toEqual({ parent: 2, child: 0 })
      expect(yield* transcript(second, session.id)).toContain(RESTART_NOTICE)
    }),
  )
})
