import { afterAll, describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { eq } from "drizzle-orm"
import { AIError, InvalidRequestError, LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import path from "path"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionContinuity } from "@opencode/core/continuity"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { JobTable } from "@opencode/core/job/sql"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { SubagentEnded } from "@opencode/core/session/subagent-ended"
import { MemoryTask } from "@opencode/core/memory/task"
import { MemoryClient } from "@opencode/core/memory/client"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { SessionTable } from "@opencode/core/session/sql"
import { catalogOf, endpointAt, startProxied } from "./memory/fixture"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const childText = "child final response"
const completedOutput = (sessionID: Session.ID) =>
  `<subagent sessionID="${sessionID}" state="completed">\n${childText}\n</subagent>`
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const overrideModel = Model.Ref.make({
  id: Model.ID.make("override"),
  providerID: Provider.ID.make("test"),
  variant: Model.VariantID.make("fast"),
})
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      // One completed answer per admitted prompt batch: a continuation adds a user prompt, so it
      // must produce a fresh answer instead of reusing the first turn's.
      const completedInbox = new Map<Session.ID, number>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        const admitted = (yield* SessionInbox.list(db, sessionID)).filter((item) => item.type === "user").length
        if (completedInbox.get(sessionID) === admitted) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completedInbox.set(sessionID, admitted)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, Database.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  name: "test/subagent-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    MemoryTask.node,
    SubagentEnded.node,
    Tool.node,
    PluginHooks.node,
    SessionContinuity.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  SessionStore.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(subagentPluginSupervisor)]),
)
const completionLLM = TestLLM.testLayer({ fallback: TestLLM.text(childText, "completion") })
const completionIt = testEffect(
  Layer.merge(
    completionLLM,
    AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(subagentPluginSupervisor),
      LayerNodePlatform.llmClient.replace(completionLLM),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

// Tasks: the small memory server behind its proxy, and a catalog that says it has tasks.
const tasksServer = startProxied()
afterAll(() => tasksServer.stop())
const tasksEndpoint = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({ get: () => Effect.succeed(endpointAt(tasksServer.origin)), changes: () => Stream.empty }),
)
const tasksIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...replacements,
    PluginSupervisor.node.replace(subagentPluginSupervisor),
    MemoryClient.node.replace(
      MemoryClient.layer.pipe(
        Layer.provide(PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(tasksEndpoint))),
      ),
    ),
    PacerModels.node.replace(
      Layer.succeed(
        PacerModels.Service,
        PacerModels.Service.of({
          get: () => Effect.succeed(catalogOf(true)),
          changes: () => Stream.empty,
          refresh: () => Effect.void,
        }),
      ),
    ),
  ]),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Provider.Service.use((providers) =>
      providers.transform((editor) => {
        editor.models.update(overrideModel.providerID, overrideModel.id, (model) => {
          model.variants = [{ id: Model.VariantID.make("fast") }]
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("plain"), () => {})
        editor.models.update(Provider.ID.make("test"), Model.ID.make("painter"), (model) => {
          model.type = "image"
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("classifier"), (model) => {
          model.type = "decision"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        editor.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        editor.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  completionIt.live("admits one durable completion across live delivery and restart replay", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
            title: "Completion recipient",
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* Deferred.make<Job.Background>()
          const notifications: SessionMessage.ID[] = []
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return
              notifications.push(event.data.inboxID)
              const marker = (yield* jobs.pendingBackground).find((job) => job.notificationID === event.data.inboxID)
              // The marker must survive until admission commits, not merely until delivery starts.
              expect(marker?.status).toBe("completed")
              if (marker) yield* Deferred.succeed(admitted, marker)
            }),
          )

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-completion-replay",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review" },
            },
          })
          const marker = yield* Deferred.await(admitted)
          yield* jobs.pendingBackground.pipe(Effect.repeat({ until: (pending) => pending.length === 0 }))
          yield* sessions.wait(parent.id)
          const messages = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(messages).toEqual([
            expect.objectContaining({
              id: marker.notificationID,
              description: "background review",
              text: `<subagent sessionID="${outputSessionID(result.metadata)}" state="completed" description="background review">\n${childText}\n</subagent>`,
              metadata: {
                source: "subagent",
                childID: outputSessionID(result.metadata),
                agent: "reviewer",
                state: "completed",
              },
            }),
          ])

          // Reproduce a crash after admission but before acknowledgment using the real persisted row.
          const database = yield* Database.Service
          yield* database.db
            .insert(JobTable)
            .values({
              notification_id: marker.notificationID,
              id: marker.id,
              session_id: parent.id,
              child_session_id: outputSessionID(result.metadata),
              kind: marker.recovery.kind,
              title: "background review",
              status: marker.status,
              output: marker.output ?? null,
              error: marker.error ?? null,
              recovery: marker.recovery,
            })
            .run()
          const restart = yield* SessionRestart.Service
          yield* restart.resumeSuspendedSessions
          yield* sessions.wait(parent.id)
          expect(notifications).toEqual([marker.notificationID])
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual(
            messages,
          )
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  productionIt.live("registers globally while resolving agents from the caller location", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toContain(SubagentTool.name)
          const definition = (yield* registry.snapshot()).definitions.find((tool) => tool.name === SubagentTool.name)
          const fields = (definition?.inputSchema as { properties: Record<string, { description?: string }> })
            .properties
          expect(fields.taskID?.description).toBe(
            "The id of the task or subtask (the task tool) this subagent is to work on: the subtask's when it does one step of a plan; give it whenever the work is a task. While you are on a step of a task, that task's own id is refused.",
          )
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
          })
        }),
      ),
    ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { status: "running" },
            content: [{ type: "text", text: expect.stringContaining("working in the background") }],
          })
          expect(settled.metadata).toEqual({
            sessionID: outputSessionID(settled.metadata),
            status: "running",
          })
          expect((yield* sessions.get(outputSessionID(settled.metadata))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("starts a child session and returns the running handle", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this", model: "", sessionID: "" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { status: "running" },
            content: [{ type: "text", text: expect.stringContaining("working in the background") }],
          })
          const child = yield* sessions.get(outputSessionID(settled.metadata))
          expect(settled.output).toMatchObject({ sessionID: child.id, status: "running" })
          expect(settled.output.output).toContain(`sessionID: ${child.id}`)
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "running" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "You are a subagent spawned by another session.\nreview this",
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue this",
                sessionID: childID,
                model: "",
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
          expect(second).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { sessionID: childID, status: "running" },
          })
        }),
      ),
    ),
  )

  it.live("steers a running child session in the background", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          yield* jobs.start({ id: child.id, type: SubagentTool.name, run: Effect.never })

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-running-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue while running",
                sessionID: child.id,
              },
            },
          })

          expect(result).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { sessionID: child.id, status: "running" },
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "continue while running",
          )
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  completionIt.live("follow-ups to a running child return immediately and notify once", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const llm = yield* TestLLM.Test
          const gate = yield* llm.gate()
          const delivered = yield* bus.subscribe(SessionEvent.InboxDelivered).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          const call = (id: string, input: { sessionID?: Session.ID }) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: id, ...input },
              },
            }).pipe(Effect.timeout("2 seconds"))

          const launched = yield* call("call-launch", {})
          const childID = outputSessionID(launched.metadata)
          yield* gate.started
          const steered = yield* call("call-steer", { sessionID: childID })
          const followed = yield* call("call-steer-again", { sessionID: childID })
          ;[launched, steered, followed].forEach((result) =>
            expect(result).toMatchObject({ metadata: { sessionID: childID, status: "running" } }),
          )

          yield* gate.release
          yield* Fiber.join(delivered).pipe(Effect.timeout("2 seconds"))
          yield* sessions.wait(parent.id)
          const notices = (yield* sessions.context(parent.id))
            .filter((message) => message.type === "synthetic")
            .filter((message) => message.metadata?.source === "subagent")
          expect(notices).toHaveLength(1)
          expect(notices[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  it.live("rejects unrelated children and switches agents on continuation", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const switched = yield* sessions.create({
            parentID: parent.id,
            title: "fallback review",
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", prompt: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-malformed-child-id",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "follow up", prompt: "continue", sessionID: "placeholder" },
              },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining('sessionID: Expected a string starting with "ses"') },
          })
          expect(yield* call(parent.id, "call-parent-id")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${parent.id} is not a child of the current session`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a child of the current session`,
            },
          })
          expect(yield* call(switched.id, "call-switched-child")).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { sessionID: switched.id, status: "running" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "reviewer",
            model: childModel,
          })
          // Switching to an agent without a configured model keeps the child's current model.
          expect(yield* call(switched.id, "call-modelless-switch", "fallback")).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { sessionID: switched.id, status: "running" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "fallback",
            model: childModel,
          })
        }),
      ),
    ),
  )

  it.live("runs the child on an explicitly requested model", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
              },
            })

          // The requested model beats the agent's configured model.
          const spawned = yield* call("call-override", { model: "test/override#fast", sessionID: "" })
          expect(spawned).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { status: "running" },
          })
          const child = yield* sessions.get(outputSessionID(spawned.metadata))
          expect(child).toMatchObject({ agent: "reviewer", model: overrideModel })

          // Continuing with a model switches the existing child even when the agent is unchanged.
          const continued = yield* call("call-override-continue", { sessionID: child.id, model: "test/override" })
          expect(continued).toMatchObject({
            status: "completed",
            output: { status: "running" },
            metadata: { sessionID: child.id, status: "running" },
          })
          expect((yield* sessions.get(child.id)).model).toEqual({
            id: overrideModel.id,
            providerID: overrideModel.providerID,
            variant: Model.VariantID.make("default"),
          })

          const failures = [
            ["not-a-ref", 'Invalid model "not-a-ref". Use "providerID/modelID" or "providerID/modelID#variant".'],
            ["test/missing", 'Model "test/missing" is not available. Use the models tool to see what is available.'],
            ["test/override#slow", 'Variant "slow" is not available for "test/override". Available: fast.'],
            ["test/plain#high", 'Model "test/plain" has no variants. Omit the variant.'],
            [
              "test/painter",
              'Model "test/painter" is an image model; subagents need a chat model. Use the models tool to find one.',
            ],
            [
              "test/classifier",
              'Model "test/classifier" is a decision model; subagents need a chat model. Use the models tool to find one.',
            ],
          ] as const
          for (const [model, message] of failures) {
            expect(yield* call(`call-${model}`, { model })).toEqual({
              status: "error",
              error: { type: "tool.execution", message },
            })
          }
        }),
      ),
    ),
  )

  completionIt.live("notifies once when background work completes", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          const delivered = yield* bus.subscribe(SessionEvent.InboxDelivered).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review" },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "running",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background review",
            metadata: {
              source: "subagent",
              childID,
              agent: "reviewer",
              state: "completed",
            },
          })
          yield* Fiber.join(delivered).pipe(Effect.timeout("2 seconds"))
          yield* sessions.wait(parent.id)
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(childText)
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  describe("with a task", () => {
    const maker = { role: "build", chat: "ses_maker" }
    /** Calls the memory server itself, as another chat would. */
    const store = (method: string, path: string, body?: unknown) =>
      fetch(`${tasksServer.store.url}${path}`, {
        method,
        headers: { authorization: "Bearer memory-client-key-f1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).then((response) => response.json() as Promise<{ task: { id: string; state: string; worker: unknown } }>)

    const prepare = Effect.fnUntraced(function* (dir: { readonly path: string }) {
      const project = `subagent-tasks-${crypto.randomUUID().slice(0, 8)}`
      yield* Effect.promise(() =>
        Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ memory: { project } })),
      )
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location, model: parentModel })
      yield* withSubagent(parent.location)
      const locations = yield* LocationServiceMap.Service
      const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
      const base = `/pacer/v1/memory/${project}`
      const make = (title: string, parentID?: string) =>
        Effect.promise(() => store("POST", `${base}/tasks`, { title, parent: parentID ?? null, by: maker })).pipe(
          Effect.map((answer) => answer.task),
        )
      const read = (id: string) =>
        Effect.promise(() => store("GET", `${base}/tasks/${id}`)).pipe(Effect.map((answer) => answer.task))
      /** What the child does with its task while it runs: the state set right after CPP set it active. */
      const meanwhile = (next: { readonly state: string; readonly note?: string } | undefined) => {
        tasksServer.control.answer = async (request) => {
          const answer = await tasksServer.pass(request)
          if (next && request.path.endsWith("/start"))
            await store("POST", request.path.replace(/\/start$/, "/state"), {
              ...next,
              by: { role: request.pacer["x-pacer-agent"], chat: request.pacer["x-pacer-chat"] },
            })
          return answer
        }
      }
      const run = (input: Record<string, unknown>, id = "call-task-subagent") =>
        executeTool(registry, {
          sessionID: parent.id,
          ...toolIdentity,
          call: { type: "tool-call", id, name: SubagentTool.name, input },
        })
      const children = Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* database.db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, parent.id))
          .all()
          .pipe(Effect.orDie)
      })
      return { sessions, parent, make, read, meanwhile, run, children, base }
    })
    const withDir = <A, E, R>(body: (dir: { readonly path: string }) => Effect.Effect<A, E, R>) =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) =>
          Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(
            Effect.ensuring(Effect.sync(() => tasksServer.reset())),
          ),
      ).pipe(Effect.flatMap(body))

    tasksIt.live(
      "a child started with taskID is inside the task, which is active in its name before its first step",
      () =>
        withDir((dir) =>
          Effect.gen(function* () {
            const h = yield* prepare(dir)
            const task = yield* h.make("Move the checks")
            const bus = yield* Bus.Service
            // The child's prompt is admitted only after its task is active: its first step comes after that.
            const before: string[] = []
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              Effect.sync(() => {
                if (event.data.sessionID === h.parent.id) return
                before.push(
                  ...tasksServer
                    .calls()
                    .filter((call) => call.path.startsWith(`${h.base}/tasks/${task.id}/`))
                    .map((call) => call.path.slice(`${h.base}/tasks/${task.id}/`.length)),
                )
              }),
            )
            h.meanwhile(undefined)
            const settled = yield* h.run({ agent: "reviewer", description: "checks", prompt: "do it", taskID: task.id })
            const child = yield* h.sessions.get(outputSessionID(settled.metadata))
            expect(settled.content).toEqual([{ type: "text", text: completedOutput(child.id) }])
            expect(child.metadata).toEqual({ memory: { task: task.id } })
            // Asked as the lead, then started as the child.
            expect(before).toEqual(["assign", "start"])
            expect(yield* h.read(task.id)).toMatchObject({
              state: "active",
              worker: { person: "floris", role: "reviewer", chat: child.id },
            })
          }),
        ),
    )

    tasksIt.live("reads the task as the parent, and sets it active as the child with its parent's", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const task = yield* h.make("Name the chats")
          h.meanwhile({ state: "done" })
          const settled = yield* h.run({ agent: "reviewer", description: "names", prompt: "do it", taskID: task.id })
          const child = yield* h.sessions.get(outputSessionID(settled.metadata))
          const chats = (sessionID: Session.ID, parentID?: Session.ID) => ({
            "x-pacer-session": PacerSessionID.make(sessionID),
            ...(parentID ? { "x-pacer-parent-session": PacerSessionID.make(parentID) } : {}),
          })
          const calls = tasksServer.calls().filter((call) => call.path.startsWith(`${h.base}/tasks/${task.id}`))
          expect(
            calls.map((call) => [
              call.method,
              call.path.slice(h.base.length),
              Object.fromEntries(Object.entries(call.pacer).filter(([name]) => name.endsWith("session"))),
            ]),
          ).toEqual([
            ["POST", `/tasks/${task.id}/assign`, chats(h.parent.id)],
            ["POST", `/tasks/${task.id}/start`, chats(child.id, h.parent.id)],
            ["GET", `/tasks/${task.id}/ended`, chats(h.parent.id)],
          ])
          expect(calls.every((call) => call.pacer["x-pacer-project"] !== undefined)).toBe(true)
          // Who asks: the lead, then the child as its role and by its own ID.
          expect(calls.map((call) => [call.pacer["x-pacer-agent"], call.pacer["x-pacer-chat"]])).toEqual([
            ["build", h.parent.id],
            ["reviewer", child.id],
            ["build", h.parent.id],
          ])
        }),
      ),
    )

    tasksIt.live("on a subtask's id the child is inside its task and the subtask, and the subtask is active", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const task = yield* h.make("The task")
          const sub = yield* h.make("A part", task.id)
          h.meanwhile(undefined)
          const settled = yield* h.run({ agent: "reviewer", description: "part", prompt: "do it", taskID: sub.id })
          const child = yield* h.sessions.get(outputSessionID(settled.metadata))
          expect(child.metadata).toEqual({ memory: { task: task.id, subtask: sub.id } })
          expect(yield* h.read(sub.id)).toMatchObject({ state: "active", worker: { chat: child.id } })
          expect((yield* h.read(task.id)).state).toBe("todo")
        }),
      ),
    )

    // The overnight tests of 2026-11-15: 2 of 3 leads gave their task's id for one step; the step cannot be told (its
    // own, or the next one: recheck 2 handed a child the lead's own step while it did the next).
    tasksIt.live(
      "on the task's id while its lead is on one of its steps, it is refused with the open steps and no child is made",
      () =>
        withDir((dir) =>
          Effect.gen(function* () {
            const h = yield* prepare(dir)
            const task = yield* h.make("The task")
            const sub = yield* h.make("A part", task.id)
            const other = yield* h.make("Another part", task.id)
            yield* Effect.promise(() =>
              store("POST", `${h.base}/tasks/${sub.id}/state`, {
                state: "active",
                by: { role: "build", chat: h.parent.id, task: task.id, subtask: sub.id },
              }),
            )
            h.meanwhile(undefined)
            const settled = yield* h.run({ agent: "reviewer", description: "part", prompt: "do it", taskID: task.id })
            expect(settled.status).toBe("error")
            // CPP's refusal, in its words.
            expect(settled.error?.message).toBe(`You are on step ${sub.id} of ${task.id} (fake): name the step.`)
            expect(yield* h.children).toEqual([])
            expect(yield* h.read(sub.id)).toMatchObject({ state: "active", worker: { chat: h.parent.id } })
            expect((yield* h.read(other.id)).state).toBe("todo")
            // The step's own id goes ahead.
            const started = yield* h.run({ agent: "reviewer", description: "part", prompt: "do it", taskID: other.id })
            const child = yield* h.sessions.get(outputSessionID(started.metadata))
            expect(child.metadata).toEqual({ memory: { task: task.id, subtask: other.id } })
          }),
        ),
    )

    tasksIt.live("an unknown task id is refused and no child is made", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const settled = yield* h.run({ agent: "reviewer", description: "x", prompt: "x", taskID: "000000000000" })
          expect(settled.status).toBe("error")
          expect(settled.error?.message).toBe("No task 000000000000 (fake).")
          expect(yield* h.children).toEqual([])
        }),
      ),
    )

    tasksIt.live(
      "the maker's answer ends with the task's state when it is blocked, review or done, and not when active",
      () =>
        withDir((dir) =>
          Effect.gen(function* () {
            const h = yield* prepare(dir)
            for (const [next, line] of [
              [{ state: "blocked", note: "the file is not there" }, (id: string) => `Task ${id} is blocked (fake).`],
              [{ state: "review" }, (id: string) => `Task ${id} is review (fake).`],
              [{ state: "done", note: "merged" }, (id: string) => `Task ${id} is done (fake).`],
              [undefined, undefined],
            ] as const) {
              const task = yield* h.make(`Ends ${next?.state ?? "active"}`)
              h.meanwhile(next)
              const settled = yield* h.run(
                { agent: "reviewer", description: "work", prompt: "do it", taskID: task.id },
                `call-${next?.state ?? "active"}`,
              )
              const childID = outputSessionID(settled.metadata)
              expect(settled.content).toEqual([
                {
                  type: "text",
                  text: line
                    ? `<subagent sessionID="${childID}" state="completed">\n${childText}\n${line(task.id)}\n</subagent>`
                    : completedOutput(childID),
                },
              ])
            }
          }),
        ),
    )

    tasksIt.live("a background child's notice ends with the task's state", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const task = yield* h.make("In the background")
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === h.parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          h.meanwhile({ state: "review", note: "ready" })
          const settled = yield* h.run({
            agent: "reviewer",
            description: "background work",
            prompt: "do it",
            taskID: task.id,
            background: true,
          })
          const childID = outputSessionID(settled.metadata)
          const admission = Array.from(yield* Fiber.join(admitted))[0]
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission.data.item.payload.text).toBe(
            `<subagent sessionID="${childID}" state="completed" description="background work">\n${childText}\nTask ${task.id} is review (fake).\n</subagent>`,
          )
        }),
      ),
    )

    tasksIt.live("a child started without taskID inherits its parent's task, and nothing is set or added", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const task = yield* h.make("The parent's task")
          yield* h.sessions.setMetadata({ sessionID: h.parent.id, metadata: { memory: { task: task.id } } })
          h.meanwhile(undefined)
          const settled = yield* h.run({ agent: "reviewer", description: "helper", prompt: "help" })
          const child = yield* h.sessions.get(outputSessionID(settled.metadata))
          expect(child.metadata).toEqual({ memory: { task: task.id } })
          expect(settled.content).toEqual([{ type: "text", text: completedOutput(child.id) }])
          expect((yield* h.read(task.id)).state).toBe("todo")
          expect(tasksServer.calls().filter((call) => call.path.includes(task.id))).toEqual([])
        }),
      ),
    )

    tasksIt.live("a child continued with a taskID moves into that task, active in its name, as a new child does", () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const h = yield* prepare(dir)
          const first = yield* h.make("The first job")
          const second = yield* h.make("The next job")
          h.meanwhile(undefined)
          const started = yield* h.run({ agent: "reviewer", description: "job", prompt: "do it", taskID: first.id })
          const id = outputSessionID(started.metadata)
          const settled = yield* h.run(
            { agent: "reviewer", description: "job", prompt: "now this", sessionID: id, taskID: second.id },
            "call-task-subagent-2",
          )
          expect(outputSessionID(settled.metadata)).toBe(id)
          expect((yield* h.sessions.get(id)).metadata).toEqual({ memory: { task: second.id } })
          expect(
            tasksServer
              .calls()
              .filter((call) => call.path.startsWith(`${h.base}/tasks/${second.id}/`))
              .map((call) => call.path.slice(`${h.base}/tasks/${second.id}/`.length)),
          ).toEqual(["assign", "start", "ended"])
          expect(yield* h.read(second.id)).toMatchObject({
            state: "active",
            worker: { person: "floris", role: "reviewer", chat: id },
          })
        }),
      ),
    )
  })
})

/** A parent with the subagent tool registered, its child calls, and every synthetic notice it received. */
const reportingFixture = () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ location, model: parentModel })
    yield* withSubagent(parent.location)
    const locations = yield* LocationServiceMap.Service
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
    const call = (id: string, input: Record<string, unknown> = {}) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call" as const,
          id,
          name: SubagentTool.name,
          input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
        },
      })
    // A notice is either still queued or already delivered to the parent; count both.
    const notices = Effect.gen(function* () {
      const pending = (yield* sessions.inbox(parent.id)).flatMap((item) =>
        item.type === "synthetic" ? [{ text: item.payload.text, metadata: item.payload.metadata }] : [],
      )
      const delivered = (yield* sessions.context(parent.id)).flatMap((message) =>
        message.type === "synthetic" ? [{ text: message.text, metadata: message.metadata }] : [],
      )
      return [...pending, ...delivered]
    })
    return { parent, sessions, call, notices }
  })

describe("SubagentTool reporting", () => {
  completionIt.live("reports the child's final answer to the parent", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const settled = yield* fixture.call("call-report")
      const childID = outputSessionID(settled.metadata)

      expect(settled).toMatchObject({
        status: "completed",
        output: { status: "running" },
        metadata: { sessionID: childID, status: "running" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(1)
      expect(reports[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
      expect(reports[0]?.text).toContain(childText)
    }),
  )

  completionIt.live("reports only the current busy period when an idle child is continued", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      yield* llm.push(TestLLM.text("first answer", "first"))

      const first = yield* fixture.call("call-first")
      const childID = outputSessionID(first.metadata)
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)
      const firstReports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(firstReports).toHaveLength(1)
      expect(firstReports[0]?.text).toContain("first answer")

      const second = yield* fixture.call("call-second", { sessionID: childID })
      expect(second).toMatchObject({
        status: "completed",
        output: { status: "running" },
        metadata: { sessionID: childID, status: "running" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(2)
      expect(reports[1]?.text).toContain(childText)
      expect(reports[1]?.text).not.toContain("first answer")
    }),
  )

  completionIt.live("reports a child runner failure to the parent", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      yield* llm.push(
        TestLLM.failAfter(
          new AIError({ reason: new InvalidRequestError({ message: "provider exploded" }) }),
          LLMEvent.textStart({ id: "failed" }),
        ),
      )

      const settled = yield* fixture.call("call-failing-child", { description: "fail review" })
      const childID = outputSessionID(settled.metadata)
      expect(settled).toMatchObject({
        status: "completed",
        output: { status: "running" },
        metadata: { sessionID: childID, status: "running" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(1)
      expect(reports[0]?.text).toContain(`<subagent sessionID="${childID}" state="error"`)
      expect(reports[0]?.text).toContain("provider exploded")
    }),
  )
})

describe("SubagentJob cancellation", () => {
  it.live("interrupts the child only for an explicit cancel and preserves shutdown claims", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.make()
      const cancelStarted = yield* Deferred.make<void>()
      const shutdownStarted = yield* Deferred.make<void>()
      const cancelChild = Session.ID.make("ses_job_cancel_child")
      const shutdownChild = Session.ID.make("ses_job_shutdown_child")
      const interrupts: Session.ID[] = []
      const interrupted = new Set<Session.ID>()
      const claimed = new Set<Session.ID>()
      const execution = SessionExecution.Service.of({
        active: Effect.succeed(new Set<Session.ID>()),
        isActive: () => Effect.succeed(false),
        resume: (sessionID) =>
          Effect.sync(() => claimed.add(sessionID)).pipe(
            Effect.andThen(
              sessionID === cancelChild
                ? Deferred.succeed(cancelStarted, undefined)
                : Deferred.succeed(shutdownStarted, undefined),
            ),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.add(sessionID))),
          ),
        wake: () => Effect.void,
        interrupt: (sessionID) =>
          Effect.sync(() => {
            interrupts.push(sessionID)
            claimed.delete(sessionID)
            return true
          }),
        awaitIdle: () => Effect.void,
      })
      const jobs = yield* Job.make.pipe(Scope.provide(scope), Effect.provideService(Database.Service, database))
      const context = yield* Layer.buildWithScope(
        SubagentJob.layer.pipe(
          Layer.provide(Layer.succeed(SessionExecution.Service, execution)),
          Layer.provide(Layer.succeed(Job.Service, jobs)),
        ),
        scope,
      )
      const subagents = Context.get(context, SubagentJob.Service)
      const recovery = (parent: string, child: Session.ID) => ({
        kind: "subagent" as const,
        parentSessionID: Session.ID.make(parent),
        childSessionID: child,
        agent: "reviewer",
        description: "review",
      })

      yield* subagents.start(recovery("ses_job_cancel_parent", cancelChild))
      yield* Deferred.await(cancelStarted)
      yield* jobs.cancel(cancelChild)
      expect(interrupted.has(cancelChild)).toBe(true)
      expect(interrupts).toEqual([cancelChild])
      expect(claimed.has(cancelChild)).toBe(false)

      // A server shutdown interrupts the job fiber but must not release the child's claim.
      yield* subagents.start(recovery("ses_job_shutdown_parent", shutdownChild))
      yield* Deferred.await(shutdownStarted)
      yield* Scope.close(scope, Exit.void)
      expect(interrupted.has(shutdownChild)).toBe(true)
      expect(interrupts).toEqual([cancelChild])
      expect(claimed.has(shutdownChild)).toBe(true)
    }),
  )
})
