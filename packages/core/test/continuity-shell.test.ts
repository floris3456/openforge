import { describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { LLMClient } from "@opencode/ai/route"
import { TestLLM } from "@opencode/ai/testing"
import { RunnerPaths } from "@opencode/runner/paths"
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
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionShell } from "@opencode/core/session/shell"
import { Shell } from "@opencode/core/shell"
import { ShellRunner } from "@opencode/core/shell/runner"
import { ShellSelect } from "@opencode/core/shell/select"
import { Tool } from "@opencode/core/tool"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { App } from "@opencode/core/app"
import { offlineModels } from "./fixture/models"
import { alive, machine } from "./fixture/runner"
import { testEffect } from "./lib/effect"
import { registerToolPlugin } from "./lib/tool"

// Service generations over one database and one machine, whose tool runner outlives them as `openforge runner` does.
// Stopping a generation marks the stop, detaches the shells and closes its scope: what SIGTERM does to the service.

const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("test") })
const RESTART_NOTICE = "The server restarted while you were working."

const plugins = makeLocationNode({
  name: "test/continuity-shell-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const select = yield* ShellSelect.Service
      yield* select.transform((editor) => editor.configure("sh"))
      yield* registerToolPlugin(ShellTool.Plugin)
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        }),
      )
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    SessionContinuity.node,
    Tool.node,
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
  ShellRunner.node,
  LocationServiceMap.node,
])

const harness = testEffect(Layer.mergeAll(AppNodeBuilder.build(Database.node), TestLLM.testLayer()))
// Windows has no tool runner: its commands run in the service and end with it.
const it = { live: process.platform === "win32" ? harness.live.skip : harness.live }

type Host = Effect.Success<typeof machine>

/** Starts a service generation; `stop` is its SIGTERM. */
const start = (host: Host, options: { readonly paused?: boolean } = {}) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const llm = yield* TestLLM.Test
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const context = yield* Layer.buildWithScope(
      AppNodeBuilder.build(nodes, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
        SessionContinuity.node.replace(SessionContinuity.configured({ paused: options.paused })),
        ShellRunner.node.replace(ShellRunner.configured({ launch: host.launch })),
        App.node.replace(App.configured({ version: "test" })),
        PluginSupervisor.node.replace(plugins),
        offlineModels,
        fixedModel,
      ]).pipe(Layer.provide(host.global)),
      scope,
    )
    const events: Event.Payload[] = []
    yield* Context.get(context, Bus.Service)
      .subscribe()
      .pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    const continuity = Context.get(context, SessionContinuity.Service)
    const restart = Context.get(context, SessionRestart.Service)
    // As the server does: the restart sweep runs once the gate is open.
    yield* continuity.awaitOpen.pipe(Effect.andThen(restart.resumeSuspendedSessions), Effect.forkIn(scope))
    const of = <D extends Event.Definition>(definition: D) =>
      events.filter((event): event is Event.Payload<D> => event.type === definition.type)
    return {
      of,
      continuity,
      sessions: Context.get(context, Session.Service),
      kv: Context.get(context, KV.Service),
      // The server marks the stop and leaves its shells to the runner before anything closes.
      stop: continuity.stop.pipe(
        Effect.andThen(Context.get(context, ShellRunner.Service).detach),
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
    }
  })

type Generation = Effect.Success<ReturnType<typeof start>>

const until = Effect.fnUntraced(function* (what: string, condition: () => boolean) {
  const deadline = performance.now() + 15_000
  while (!condition()) {
    if (performance.now() > deadline) return yield* Effect.die(new Error(`${what} never happened within 15s`))
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
})

const succeeded = (generation: Generation, sessionID: Session.ID) =>
  until("the turn's success", () =>
    generation.of(SessionEvent.Execution.Succeeded).some((event) => event.data.sessionID === sessionID),
  )

const transcript = (generation: Generation, sessionID: Session.ID) =>
  generation.sessions.messages({ sessionID }).pipe(Effect.map((messages) => JSON.stringify(messages)))

/** A command that counts its runs, then waits for the test before it prints `done`. */
const gated = (directory: string) => {
  const runs = path.join(directory, "runs")
  const release = path.join(directory, "release")
  return {
    command: `echo run >> '${runs}'; while [ ! -e '${release}' ]; do sleep 0.02; done; echo done`,
    runs: () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0),
    release: () => fs.writeFileSync(release, ""),
  }
}

const setup = Effect.fnUntraced(function* (host: Host, generation: Generation) {
  const directory = path.join(host.project, crypto.randomUUID())
  fs.mkdirSync(directory)
  const session = yield* generation.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
    model,
    title: "continuity shell",
  })
  return { session, directory, command: gated(directory) }
})

/** The model calls the shell tool once, then answers. */
const shellTool = (llm: TestLLM.TestInterface, command: string) =>
  llm.push(TestLLM.toolCall("call_shell", "shell", { command }), TestLLM.text("all done", "t1"))

/** The shell calls of a Session, as the model saw them. */
const shellCalls = (generation: Generation, sessionID: Session.ID) =>
  generation.sessions
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.flatMap((message) =>
          message.type === "assistant"
            ? message.content.flatMap((part) => (part.type === "tool" && part.name === "shell" ? [part.state] : []))
            : [],
        ),
      ),
    )

const created = (generation: Generation) => generation.of(Shell.Event.Created).map((event) => event.data.info)

describe("a foreground shell tool call across a stop", () => {
  for (const paused of [true, false])
    it.live(
      paused
        ? "after a rested stop it gets its command's real result, which ran once, with the same model requests and no restart notice"
        : "after a stop without a pause (the crash path) it still gets its command's result, with the restart notice",
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLM.Test
          const host = yield* machine
          const first = yield* start(host)
          const chat = yield* setup(host, first)
          yield* shellTool(llm, chat.command.command)
          yield* first.sessions.prompt({ sessionID: chat.session.id, text: "run it" })
          yield* until("the command's start", () => chat.command.runs() === 1)

          if (paused) {
            const result = yield* first.continuity.pause()
            expect(result).toEqual({ paused: true, rested: [chat.session.id] })
          }
          yield* first.stop
          const pid = created(first)[0]?.pid ?? 0
          expect(pid).toBeGreaterThan(0)
          expect(alive(pid)).toBe(true)

          const second = yield* start(host, { paused })
          if (paused) yield* second.continuity.resume
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
          expect(chat.command.runs()).toBe(1)
          chat.command.release()
          yield* succeeded(second, chat.session.id)

          expect(chat.command.runs()).toBe(1)
          expect(yield* shellCalls(second, chat.session.id)).toMatchObject([
            { status: "completed", content: [{ type: "text", text: "done\n" }] },
          ])
          const text = yield* transcript(second, chat.session.id)
          expect(text).toContain("all done")
          // The same requests as without the stop: the call, then the step after its result.
          expect((yield* llm.requests()).length).toBe(2)
          if (paused) expect(text).not.toContain(RESTART_NOTICE)
          else expect(text).toContain(RESTART_NOTICE)
          expect(created(second)).toEqual([])
        }),
      { timeout: 30_000 },
    )

  it.live("a user interrupt of the turn still ends the command", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Test
      const host = yield* machine
      const first = yield* start(host)
      const chat = yield* setup(host, first)
      yield* shellTool(llm, chat.command.command)
      yield* first.sessions.prompt({ sessionID: chat.session.id, text: "run it" })
      yield* until("the command's start", () => chat.command.runs() === 1)
      const pid = created(first)[0]?.pid ?? 0
      expect(alive(pid)).toBe(true)
      yield* first.sessions.interrupt(chat.session.id)
      yield* until("the command's end", () => !alive(pid))
    }),
  )
})

describe("a `!` command across a stop", () => {
  for (const finished of [false, true])
    it.live(
      finished
        ? "one that finished while no service ran is reported by the next one, once"
        : "one still running is reported by the next service when it ends, once",
      () =>
        Effect.gen(function* () {
          const host = yield* machine
          const first = yield* start(host)
          const chat = yield* setup(host, first)
          const running = yield* first.sessions
            .shell({ sessionID: chat.session.id, command: chat.command.command })
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* until("the command's start", () => chat.command.runs() === 1)
          yield* first.stop
          yield* Fiber.interrupt(running)
          const started = first.of(SessionEvent.Shell.Started).map((event) => event.data.shell.id)
          expect(started).toHaveLength(1)
          expect(first.of(SessionEvent.Shell.Ended)).toEqual([])
          if (finished) {
            chat.command.release()
            const file = created(first)[0]?.file ?? ""
            yield* until("the command's exit file", () => fs.existsSync(RunnerPaths.exit(file)))
          }

          const second = yield* start(host)
          if (!finished) {
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
            expect(second.of(SessionEvent.Shell.Ended)).toEqual([])
            chat.command.release()
          }
          yield* until("the command's end", () => second.of(SessionEvent.Shell.Ended).length > 0)
          const notices = yield* reported(second, chat.session.id)
          expect(notices).toHaveLength(1)
          expect(notices[0]).toContain("The following shell command was executed by the user")
          expect(notices[0]).toContain("done")
          expect(yield* second.kv.get(SessionShell.key(started[0]))).toBeUndefined()
          const messages = yield* second.sessions.messages({ sessionID: chat.session.id })
          expect(messages.filter((message) => message.type === "shell")).toMatchObject([
            { shellID: started[0], status: "exited", exit: 0 },
          ])
          yield* second.stop

          // Reported: a later service does not report it again.
          const third = yield* start(host)
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
          expect(third.of(SessionEvent.Shell.Ended)).toEqual([])
          expect(yield* reported(third, chat.session.id)).toHaveLength(1)
          expect(chat.command.runs()).toBe(1)
        }),
      { timeout: 30_000 },
    )
})

const reported = (generation: Generation, sessionID: Session.ID) =>
  generation.sessions
    .inbox(sessionID)
    .pipe(
      Effect.map((items) =>
        items.flatMap((item) =>
          item.type === "synthetic" && item.payload.metadata?.source === "shell" ? [item.payload.text] : [],
        ),
      ),
    )
