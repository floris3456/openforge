import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { MemoryClient } from "@opencode/core/memory/client"
import { MemoryPlans } from "@opencode/core/memory/plans"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { TaskPlansPlugin } from "@opencode/core/plugin/task-plans"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { MemoryTools } from "@opencode/core/tool/plugin/memory"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { promptLocationNode } from "../fixture/prompt-location"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { registerToolPlugin } from "../lib/tool"
import { catalogOf, endpointAt, key, startProxied } from "./fixture"

// Task plans' enforcement through the real runner (the workspace's spec `docs/specs/task-plans.md`, sections 6, 8 and
// 10): an edit, write or patch in a chat in no task changes nothing, and a turn inside a task that changed something
// without a task call ends with one check. The real file tools work in a directory of the file's own; the memory server
// is the small one, one for the file, each test in a project of its own.

const server = startProxied()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-plans-")))
afterAll(async () => {
  await server.stop()
  fs.rmSync(root, { recursive: true, force: true })
})
const planned = () => catalogOf(true, { prompt: false, plans: true })

const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(server.origin)))
const catalogRef = Effect.runSync(SubscriptionRef.make<PacerModels.Catalog | undefined>(planned()))

const requests: LLMRequest[] = []
const testLLM = TestLLM.testLayer({
  fallback: TestLLM.text("Done.", "done"),
  transformRequest: (request) => {
    requests.push(request)
    return request
  },
})
const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const none = { load: () => Effect.succeed(Instructions.empty) }
const endpoints = Layer.succeed(
  PacerEndpoint.Service,
  PacerEndpoint.Service.of({
    get: () => SubscriptionRef.get(endpointRef),
    changes: () => SubscriptionRef.changes(endpointRef),
  }),
)
const catalogs = Layer.succeed(
  PacerModels.Service,
  PacerModels.Service.of({
    get: () => SubscriptionRef.get(catalogRef),
    changes: () => SubscriptionRef.changes(catalogRef),
    refresh: () => Effect.void,
  }),
)
const client = Layer.fresh(MemoryClient.layer).pipe(
  Layer.provide(Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoints))),
)
/** What a shell command reaches here: nothing runs, but the runner records the call as a real one would be. */
const shell = makeLocationNode({
  name: "test/task-plans-shell",
  layer: Layer.effectDiscard(
    Tool.Service.use((registry) =>
      registry.transform((editor) => {
        editor.add({
          name: "shell",
          description: "Run a shell command",
          options: { codemode: false },
          input: Schema.Struct({ command: Schema.String }),
          output: Schema.Struct({ output: Schema.String }),
          execute: () => Effect.succeed({ output: { output: "" }, content: "(no output)" }),
        })
      }),
    ),
  ),
  deps: [Tool.node],
})
const files = makeLocationNode({
  name: "test/task-plans-file-tools",
  layer: Layer.effectDiscard(
    Effect.all([
      registerToolPlugin(EditTool.Plugin),
      registerToolPlugin(WriteTool.Plugin),
      registerToolPlugin(PatchTool.Plugin),
    ]),
  ),
  deps: [
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Permission.node,
    Location.node,
  ],
})
// Memory's own tools as in openforge; their calls read only the chat, which the store answers.
const memoryTools = makeLocationNode({
  name: "test/task-plans-memory-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      yield* registerToolPlugin(MemoryTools.Plugin).pipe(
        Effect.provide(
          Layer.mock(Session.Service, {
            get: (sessionID) =>
              store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((found) =>
                    found ? Effect.succeed(found) : Effect.fail(new Session.NotFoundError({ sessionID })),
                  ),
                ),
            revert: {
              stage: () => Effect.die("unused"),
              clear: () => Effect.die("unused"),
              commit: () => Effect.die("unused"),
            },
          }),
        ),
      )
    }),
  ),
  deps: [
    Tool.node,
    Permission.node,
    PacerEndpoint.node,
    PacerModels.node,
    MemoryClient.node,
    PacerProject.node,
    SessionStore.node,
    Config.node,
    KV.node,
  ],
})
const replacements: LayerNode.Replacements = [
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(models),
  InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, none)),
  InstructionDiscovery.node.replace(Layer.mock(InstructionDiscovery.Service, { project: true, global: true, ...none })),
  SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, none)),
  ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, none)),
  McpInstructions.node.replace(Layer.mock(McpInstructions.Service, none)),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(root) })),
  Config.node.replace(Config.testLayer()),
  Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
  Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
  PluginSupervisor.node.replace(Layer.empty),
  Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  PacerEndpoint.node.replace(endpoints),
  PacerModels.node.replace(catalogs),
  MemoryClient.node.replace(client),
]
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const drain = (sessionID: Session.ID, force: boolean): Effect.Effect<void, SessionRunner.RunError> =>
      runner.drain({ sessionID, force }).pipe(Effect.asVoid)
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({ drain })
    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: (sessionID) => coordinator.interrupt(sessionID),
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(SessionRunnerLLM.node, replacements)), Layer.orDie)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    KV.node,
    Bus.node,
    Job.node,
    SessionProjector.node,
    SessionStore.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    shell,
    files,
    memoryTools,
    MemoryPlans.node,
    Config.node,
    Snapshot.node,
    SessionRunnerLLM.node,
    Session.node,
  ]),
  [
    ...replacements,
    Bus.node.replace(Bus.configured({ persist: true })),
    LocationServiceMap.node.replace(promptLocationNode),
    Model.node.replace(
      Layer.mock(Model.Service, {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.undefined,
        small: () => Effect.undefined,
      }),
    ),
    SessionExecution.node.replace(execution),
  ],
).pipe(Layer.provideMerge(testLLM))
const it = testEffect(layer)

const memory = Effect.provide(MemoryClient.Service, client)
/** The services of each test, built for it, that the task-plans plugin is registered with. */
const registered = new WeakSet<PluginHooks.Interface>()
const by = { role: "build", chat: "ses_task_plans_maker" }

/**
 * A chat in a project of its own, a lead or a child of another, inside a task or in none.
 */
const setup = Effect.fnUntraced(function* (
  input: {
    readonly agent?: string
    readonly child?: boolean
    /** Where the chat is, made from its project before the chat is stored: a task, set active, and its subtask. */
    readonly inside?: "task" | "subtask" | "active subtask"
    readonly catalog?: PacerModels.Catalog
  } = {},
) {
  Effect.runSync(SubscriptionRef.set(catalogRef, input.catalog ?? planned()))
  server.reset()
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
    })
    // One whose permissions take the task tool away.
    editor.update(Agent.ID.make("untasked"), (agent) => {
      agent.mode = "subagent"
      agent.permissions = [{ action: "task", resource: "*", effect: "deny" }]
    })
  })
  const project = Project.ID.make(crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"))
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: AbsolutePath.make(root), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const tasks = yield* memory
  const make = (title: string, parent?: string) =>
    tasks.make(project, { title, ...(parent ? { parent } : {}), by }).pipe(
      Effect.map((made) => made.task),
      Effect.orDie,
    )
  const activate = (id: string) => tasks.change(project, id, { state: "active", by }).pipe(Effect.orDie)
  const task = input.inside ? yield* make("Fix the typo") : undefined
  if (task) yield* activate(task.id)
  const subtask = task && input.inside !== "task" ? yield* make("The first file", task.id) : undefined
  if (subtask && input.inside === "active subtask") yield* activate(subtask.id)
  const inside = task
    ? { task: task.id, ...(input.inside === "subtask" && subtask ? { subtask: subtask.id } : {}) }
    : undefined
  const insert = (id: Session.ID, parent?: Session.ID, agent?: string) =>
    db
      .insert(SessionTable)
      .values({
        id,
        ...(parent ? { parent_id: parent } : {}),
        ...(inside ? { metadata: { memory: inside } } : {}),
        ...(agent ? { agent: Agent.ID.make(agent) } : {}),
        project_id: project,
        slug: id,
        directory: root,
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  const lead = Session.ID.make(`ses_plans_${project.slice(0, 12)}`)
  yield* insert(lead)
  const sessionID = input.child ? Session.ID.make(`${lead}_child`) : lead
  if (input.child) yield* insert(sessionID, lead, input.agent)

  const session = yield* Session.Service
  const hooks = yield* PluginHooks.Service
  // As openforge registers it, once for the test's services: its hooks are the runner's.
  if (!registered.has(hooks)) {
    registered.add(hooks)
    yield* registerToolPlugin(
      TaskPlansPlugin.Plugin,
      {
        session: {
          get: (input) => session.get(input.sessionID),
          context: (input) => session.context(input.sessionID),
          synthetic: session.synthetic,
          hook: (name, callback, options) => hooks.register("session", name, callback, options),
        },
      },
      (name, callback) => hooks.register("tool", name, callback),
    )
  }
  const llm = yield* TestLLM.Test
  const started = requests.length
  return {
    project,
    sessionID,
    session,
    llm,
    task,
    subtask,
    /** The model requests of this test. */
    requests: () => requests.slice(started),
    prompt: (text: string) =>
      session.prompt({ sessionID, text, resume: false }).pipe(Effect.andThen(session.resume(sessionID))),
    /** The checks the chat holds, in order. */
    checks: () =>
      session
        .messages({ sessionID, order: "asc" })
        .pipe(
          Effect.map((messages) =>
            messages.flatMap((message) =>
              message.type === "synthetic" && message.metadata?.source === TaskPlansPlugin.SOURCE ? [message] : [],
            ),
          ),
        ),
    /** The results of the chat's tool calls, by call. */
    results: () =>
      session.messages({ sessionID, order: "asc" }).pipe(
        Effect.map((messages) =>
          messages.flatMap((message) =>
            message.type === "assistant"
              ? message.content.flatMap((part) =>
                  part.type === "tool"
                    ? [
                        {
                          name: part.name,
                          status: part.state.status,
                          error: part.state.status === "error" ? part.state.error.message : undefined,
                        },
                      ]
                    : [],
                )
              : [],
          ),
        ),
      ),
  }
})

/** A file of the test's own under the chat's directory, with its text. */
const file = (name: string, text?: string) => {
  const target = path.join(root, `${crypto.randomUUID().slice(0, 8)}-${name}`)
  if (text !== undefined) fs.writeFileSync(target, text)
  return {
    name: path.basename(target),
    read: () => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined),
  }
}

const lead = MemoryPlans.refused(true)

describe("an edit outside a task", () => {
  it.live("an edit, a write and a patch in a chat in no task change nothing and say to make the task first", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const edited = file("edited.txt", "before\n")
      const written = file("written.txt")
      const patched = file("patched.txt", "before\n")
      yield* h.llm.push(
        TestLLM.toolCall("call-edit", "edit", { path: edited.name, oldString: "before", newString: "after" }),
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.toolCall("call-patch", "patch", {
          patchText: `*** Begin Patch\n*** Update File: ${patched.name}\n@@\n-before\n+after\n*** End Patch`,
        }),
        TestLLM.text("I made a task first next time.", "after"),
      )
      yield* h.prompt("fix the typo")
      expect(yield* h.results()).toEqual([
        { name: "edit", status: "error", error: lead },
        { name: "write", status: "error", error: lead },
        { name: "patch", status: "error", error: lead },
      ])
      expect(edited.read()).toBe("before\n")
      expect(written.read()).toBeUndefined()
      expect(patched.read()).toBe("before\n")
      expect(lead).toBe(
        "This chat is in no task, so nothing was changed. Make the task first with the task tool (its summary and the subtasks you now believe in), then make the change.",
      )
      // Outside a task there is no check.
      expect(yield* h.checks()).toEqual([])
    }),
  )

  it.live("a shell command is never refused", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "git status" }), TestLLM.text("Clean.", "a"))
      yield* h.prompt("is the tree clean?")
      expect(yield* h.results()).toEqual([{ name: "shell", status: "completed", error: undefined }])
      expect(yield* h.checks()).toEqual([])
    }),
  )

  it.live("a subagent in no task is refused with what to tell its lead", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "explore" })
      const written = file("child.txt")
      yield* h.llm.push(
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("My lead must make the task.", "after"),
      )
      yield* h.prompt("write the file")
      expect(yield* h.results()).toEqual([{ name: "write", status: "error", error: MemoryPlans.refused(false) }])
      expect(written.read()).toBeUndefined()
    }),
  )

  it.live("runs inside a task, on a server without plans, and for a chat without the task tool", () =>
    Effect.gen(function* () {
      for (const input of [
        { inside: "task" },
        { catalog: catalogOf(true, { prompt: false }) },
        { child: true, agent: "untasked" },
      ] as const) {
        const h = yield* setup(input)
        const edited = file("edited.txt", "before\n")
        const written = file("written.txt")
        const patched = file("patched.txt", "before\n")
        yield* h.llm.push(
          TestLLM.toolCall("call-edit", "edit", { path: edited.name, oldString: "before", newString: "after" }),
          TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
          TestLLM.toolCall("call-patch", "patch", {
            patchText: `*** Begin Patch\n*** Update File: ${patched.name}\n@@\n-before\n+after\n*** End Patch`,
          }),
          TestLLM.text("Fixed.", "after"),
          // Inside the task the check comes after the turn.
          ...("inside" in input ? [TestLLM.text("It goes on.", "goes-on")] : []),
        )
        yield* h.prompt("fix the typo")
        const results = (yield* h.results()).slice(0, 3)
        expect({ input, results }).toEqual({
          input,
          results: ["edit", "write", "patch"].map((name) => ({ name, status: "completed", error: undefined })),
        })
        expect([edited.read(), written.read(), patched.read()]).toEqual(["after\n", "new", "after\n"])
      }
    }),
  )
})

describe("the check at the end of a turn", () => {
  const line = (item: { readonly id: string; readonly title: string }) =>
    MemoryPlans.check(item as MemoryClient.Task, true)

  it.live("comes once after a turn that edited without a task call, as the last message, and the model goes on", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      const written = file("written.txt")
      yield* h.llm.push(
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("Fixed.", "fixed"),
        // The step after the check: it changes something again, and no second check comes.
        TestLLM.toolCall("call-write-2", "write", { path: written.name, content: "newer" }),
        TestLLM.text("It goes on.", "goes-on"),
      )
      yield* h.prompt("fix the typo")
      const checks = yield* h.checks()
      expect(checks.map((message) => message.type === "synthetic" && [message.text, message.description])).toEqual([
        [line(h.task!), "Task check"],
      ])
      expect(line(h.task!)).toBe(
        `Task check: [${h.task!.id}] Fix the typo is still active. Mark what is now true with the task tool (done starts the next subtask, plan replaces those not started, blocked says what is wrong), or answer that it goes on.`,
      )
      // The step after it got it at the end of the chat, after what came before as it was sent.
      const [, second, third] = h.requests()
      expect(h.requests()).toHaveLength(4)
      expect(JSON.stringify(third?.messages.at(-1))).toContain("Task check:")
      expect(JSON.stringify(third?.messages.slice(0, second?.messages.length))).toBe(JSON.stringify(second?.messages))
      expect(written.read()).toBe("newer")
    }),
  )

  it.live("a shell command counts; a turn that called the task tool, or changed nothing, gets none", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "bun test" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("run the tests")
      expect(yield* h.checks()).toHaveLength(1)

      yield* h.llm.push(
        TestLLM.toolCall("call-shell-2", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-task", "task", { id: h.task!.id }),
        TestLLM.text("Read it.", "read"),
      )
      yield* h.prompt("run them again and look at the task")
      yield* h.llm.push(TestLLM.text("Nothing to change.", "nothing"))
      yield* h.prompt("anything else?")
      expect(yield* h.checks()).toHaveLength(1)
    }),
  )

  it.live("comes again in the next turn that changes something", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      for (const turn of ["one", "two"]) {
        yield* h.llm.push(
          TestLLM.toolCall(`call-${turn}`, "shell", { command: "bun test" }),
          TestLLM.text("Ran.", `ran-${turn}`),
          TestLLM.text("It goes on.", `goes-on-${turn}`),
        )
        yield* h.prompt(`run the tests, turn ${turn}`)
      }
      expect(yield* h.checks()).toHaveLength(2)
    }),
  )

  it.live("names the chat's subtask, or else the task's active one; a subagent is told to answer again", () =>
    Effect.gen(function* () {
      for (const inside of ["subtask", "active subtask"] as const) {
        const h = yield* setup({ inside })
        // Its own subtask is active once it works on it.
        if (inside === "subtask")
          yield* memory.pipe(
            Effect.flatMap((tasks) => tasks.change(h.project, h.subtask!.id, { state: "active", by })),
            Effect.orDie,
          )
        yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
        yield* h.prompt("go on")
        expect((yield* h.checks()).map((message) => message.type === "synthetic" && message.text)).toEqual([
          line(h.subtask!),
        ])
      }

      const child = yield* setup({ inside: "task", child: true, agent: "explore" })
      yield* child.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
      yield* child.prompt("go on")
      expect((yield* child.checks()).map((message) => message.type === "synthetic" && message.text)).toEqual([
        `${line(child.task!)} Then give your answer again: your lead reads only your last message.`,
      ])
    }),
  )

  it.live("none while the task is not active, on a server without plans, or for a chat without the task tool", () =>
    Effect.gen(function* () {
      for (const input of [
        // Its subtask, the one it is on, is still todo.
        { inside: "subtask" },
        { inside: "task", catalog: catalogOf(true, { prompt: false }) },
        { inside: "task", child: true, agent: "untasked" },
      ] as const) {
        const h = yield* setup(input)
        yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
        yield* h.prompt("go on")
        expect({ input, checks: yield* h.checks() }).toEqual({ input, checks: [] })
      }
    }),
  )

  it.live("a read that fails gives none, and the chat goes idle as before", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      server.control.answer = (request) =>
        request.method === "GET" && request.path.includes("/tasks/")
          ? Response.json({ error: { type: "internal", message: "boom" } }, { status: 500 })
          : fetch(`${server.store.url}${request.path}`, {
              method: request.method,
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            })
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("go on")
      expect(yield* h.checks()).toEqual([])
      expect(h.requests()).toHaveLength(2)
      expect(
        server.calls().filter((call) => call.path === `/pacer/v1/memory/${h.project}/tasks/${h.task!.id}`),
      ).toHaveLength(1)
    }),
  )

  it.live("waits while the chat's own subagent runs, and comes once it is done", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      const jobs = yield* Job.Service
      const child = yield* h.session.create({
        parentID: h.sessionID,
        title: "Explore",
        agent: Agent.ID.make("explore"),
      })
      const done = yield* Deferred.make<string>()
      yield* jobs.start({
        id: child.id,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: h.sessionID,
          childSessionID: child.id,
          agent: "explore",
          description: "Explore",
        },
        run: Deferred.await(done),
      })
      yield* jobs.background(child.id)
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Waiting.", "wait"))
      yield* h.prompt("go on")
      expect(yield* h.checks()).toEqual([])

      // The subagent's notice wakes the chat, and the check comes once nothing of its own runs.
      yield* Deferred.succeed(done, "Found it")
      yield* jobs.wait({ id: child.id })
      yield* h.llm.push(TestLLM.text("Got it.", "got"), TestLLM.text("It goes on.", "goes-on"))
      yield* h.session.synthetic({ sessionID: h.sessionID, text: "Subagent finished" })
      yield* h.session.wait(h.sessionID)
      expect(yield* h.checks()).toHaveLength(1)
    }),
  )
})
