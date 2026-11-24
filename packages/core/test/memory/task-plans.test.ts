import fs from "fs"
import { FileWrite } from "@opencode/core/file-write"
import { Flag } from "@opencode/core/flag"
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
import { MemoryTask } from "@opencode/core/memory/task"
import { MemoryTexts } from "@opencode/core/memory/texts"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerTools } from "@opencode/core/pacer/tools"
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
import { PromptStartTable } from "@opencode/core/session/prompt-start.sql"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Document, Info } from "@opencode/schema/config"
import { eq } from "drizzle-orm"
import { Context, Deferred, Effect, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { promptLocationNode } from "../fixture/prompt-location"
import { initGit } from "../fixture/git"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { registerToolPlugin } from "../lib/tool"
import { texts } from "../pacer/memory-harness"
import { catalogOf, codeModeList, endpointAt, key, pacerToolsNode, poll, primeTools, startProxied } from "./fixture"

// Task plans' enforcement through the real runner (the workspace's spec `docs/specs/task-plans.md`, sections 6, 8 and
// 10): an edit, write or patch in a chat in no task changes nothing, and a turn inside a task that changed something
// without a task call ends with one check. The real file tools work in a directory of the file's own; the memory server
// is the small one, one for the file, each test in a project of its own.

const server = startProxied()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-plans-")))
// A git repository: only its chats have a project, and with it memory and the task tool.
await initGit(root)
afterAll(async () => {
  await server.stop()
  fs.rmSync(root, { recursive: true, force: true })
})
const planned = () => catalogOf(true, { prompt: false, plans: true })
/** The server's catalog with `task` in Code Mode, as CLIProxyPacer's `tools.task_codemode` makes it. */
const codeMode = () => catalogOf(true, { prompt: false, plans: true, codemode: ["task"] })
/** openforge's config, in the test's hands: `freeze_prompt` off leaves a chat's start unrecorded. */
const configs = Effect.runSync(Layer.build(Config.testLayer()).pipe(Effect.scoped))
const config = Context.get(configs, Config.Test)

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
    FileWrite.node,
    Config.node,
    Flag.node,
  ],
})
// CPP's tools as openforge registers them, the memory tools among them.
const memoryTools = pacerToolsNode("test/task-plans-pacer-tools")
const replacements: LayerNode.Replacements = [
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(models),
  InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, none)),
  InstructionDiscovery.node.replace(
    Layer.mock(InstructionDiscovery.Service, { project: true, global: true, claude: false, ...none }),
  ),
  SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, none)),
  ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, none)),
  McpInstructions.node.replace(Layer.mock(McpInstructions.Service, none)),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(root) })),
  Config.node.replace(Layer.succeedContext(configs)),
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
    PacerTools.node,
    MemoryTexts.node,
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

/** The services of each test, built for it, that the task-plans plugin is registered with. */
const registered = new WeakSet<PluginHooks.Interface>()
/** The chats the plugin read, one entry a read. */
const reads: Session.ID[] = []
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
    /** Which chat made the subtask: this one, its lead, or (left out) another. */
    readonly subtaskBy?: "self" | "lead"
    readonly catalog?: PacerModels.Catalog
    /** The server's `tools.task_codemode`: `task` runs in Code Mode, as its capabilities and its list say. */
    readonly codemode?: boolean
  } = {},
) {
  Effect.runSync(SubscriptionRef.set(catalogRef, input.codemode ? codeMode() : (input.catalog ?? planned())))
  server.reset()
  // The list's meta says it too, or a list read would learn `task` back as a direct tool.
  server.control.answer = input.codemode ? codeModeList(server, ["task"]) : undefined
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
  const lead = Session.ID.make(`ses_plans_${project.slice(0, 12)}`)
  const sessionID = input.child ? Session.ID.make(`${lead}_child`) : lead
  const make = (title: string, parent?: string, maker = by) =>
    Effect.promise(() =>
      fetch(`${server.store.url}/pacer/v1/memory/${project}/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ title, ...(parent ? { parent } : {}), by: maker }),
      }).then((answer) => answer.json() as Promise<{ task: { id: string; title: string } }>),
    ).pipe(Effect.map((made) => made.task))
  const task = input.inside ? yield* make("Fix the typo") : undefined
  if (task) yield* activate(server, project, task.id)
  const maker =
    input.subtaskBy === undefined ? by : { role: "build", chat: input.subtaskBy === "self" ? sessionID : lead }
  const subtask = task && input.inside !== "task" ? yield* make("The first file", task.id, maker) : undefined
  if (subtask && input.inside === "active subtask") yield* activate(server, project, subtask.id)
  const inside = task
    ? { task: task.id, ...(input.inside === "subtask" && subtask ? { subtask: subtask.id } : {}) }
    : undefined
  // CPP keeps the chat's place; openforge's metadata says the same, as after the call that put it there.
  if (inside)
    server.store.place(key, PacerSessionID.make(sessionID), { task: inside.task, subtask: inside.subtask ?? null })
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
  yield* insert(lead)
  if (input.child) yield* insert(sessionID, lead, input.agent)

  yield* primeTools(project)
  // memory's texts, read once the server's catalog said it serves them.
  const memoryTexts = yield* MemoryTexts.Service
  yield* poll("memory's texts are kept", () => Effect.runSync(memoryTexts.get()) !== undefined)
  const session = yield* Session.Service
  const hooks = yield* PluginHooks.Service
  // As openforge registers it, once for the test's services: its hooks are the runner's.
  if (!registered.has(hooks)) {
    registered.add(hooks)
    yield* registerToolPlugin(
      TaskPlansPlugin.Plugin,
      {
        session: {
          get: (input) =>
            Effect.sync(() => reads.push(input.sessionID)).pipe(Effect.andThen(session.get(input.sessionID))),
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

/** Sets a task active as a chat of 0.0.42 did, through the memory API. */
const activate = (served: typeof server, project: string, id: string, maker = by) =>
  Effect.promise(() =>
    fetch(`${served.store.url}/pacer/v1/memory/${project}/tasks/${id}/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "active", by: maker }),
    }),
  )

/** A file of the test's own under the chat's directory, with its text. */
const file = (name: string, text?: string) => {
  const target = path.join(root, `${crypto.randomUUID().slice(0, 8)}-${name}`)
  if (text !== undefined) fs.writeFileSync(target, text)
  return {
    name: path.basename(target),
    read: () => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined),
  }
}

const refused = texts.refused

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
        { name: "edit", status: "error", error: refused },
        { name: "write", status: "error", error: refused },
        { name: "patch", status: "error", error: refused },
      ])
      expect(edited.read()).toBe("before\n")
      expect(written.read()).toBeUndefined()
      expect(patched.read()).toBe("before\n")
      // Outside a task there is no check.
      expect(yield* h.checks()).toEqual([])
    }),
  )

  it.live("with task in Code Mode, an edit in no task changes nothing and says to make the task first", () =>
    Effect.gen(function* () {
      const h = yield* setup({ codemode: true })
      const written = file("codemode.txt")
      yield* h.llm.push(
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("I make the task first next time.", "after"),
      )
      yield* h.prompt("write the file")
      expect(yield* h.results()).toEqual([{ name: "write", status: "error", error: refused }])
      expect(written.read()).toBeUndefined()
      expect(yield* h.checks()).toEqual([])
    }),
  )

  it.live("with `execute` recorded and the catalog not saying task is Code Mode's, the chat is not planned", () =>
    Effect.gen(function* () {
      const h = yield* setup({ codemode: true })
      yield* h.llm.push(TestLLM.text("Ready.", "ready"))
      yield* h.prompt("hello")
      const plans = yield* MemoryPlans.Service
      const session = yield* h.session.get(h.sessionID)
      // Its latest cold point recorded `execute`, and the catalog says `task` runs in it.
      expect(yield* plans.planned(session)).toBe(true)
      // The catalog changes back: `task` is no longer Code Mode's, so `execute` does not stand for it.
      Effect.runSync(SubscriptionRef.set(catalogRef, planned()))
      expect(yield* plans.planned(session)).toBe(false)
    }),
  )

  it.live("goes ahead while memory cannot be reached, as no task could be made then", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      // The start block goes in; memory is gone by the time of the edit.
      server.control.answer = (request) =>
        request.method === "GET" && request.path === `/pacer/v1/memory/${h.project}/chat`
          ? Response.json({ error: { type: "internal", message: "down" } }, { status: 503 })
          : server.pass(request)
      const edited = file("unreached.txt", "before\n")
      yield* h.llm.push(
        TestLLM.toolCall("call-edit", "edit", { path: edited.name, oldString: "before", newString: "after" }),
        TestLLM.text("Edited.", "after"),
      )
      yield* h.prompt("fix the typo")
      expect(yield* h.results()).toEqual([{ name: "edit", status: "completed", error: undefined }])
      expect(edited.read()).toBe("after\n")
      // The edit asks CPP for the chat's place, to know whether a task could be made.
      expect(
        server.calls().filter((call) => call.method === "GET" && call.path === `/pacer/v1/memory/${h.project}/chat`),
      ).toHaveLength(1)
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

  it.live("a subagent in no task is refused the same way: it may make its own task", () =>
    Effect.gen(function* () {
      const h = yield* setup({ child: true, agent: "explore" })
      const written = file("child.txt")
      yield* h.llm.push(
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("I make the task first next time.", "after"),
      )
      yield* h.prompt("write the file")
      expect(yield* h.results()).toEqual([{ name: "write", status: "error", error: refused }])
      expect(written.read()).toBeUndefined()
    }),
  )

  it.live("runs inside a task, on a server that serves no memory tools, and for a chat without the task tool", () =>
    Effect.gen(function* () {
      for (const input of [
        { inside: "task" },
        { catalog: catalogOf(true, { prompt: false, tools: false }) },
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

  it.live("with the start unrecorded (freeze_prompt off), goes by whether the agent may call the task tool", () =>
    Effect.gen(function* () {
      yield* config.setEntries([new Document({ type: "document", info: new Info({ freeze_prompt: false }) })])
      yield* Effect.addFinalizer(() => config.setEntries([]))
      for (const [input, refused] of [
        [{}, true],
        [{ child: true, agent: "untasked" }, false],
      ] as const) {
        const h = yield* setup(input)
        const written = file("written.txt")
        yield* h.llm.push(
          TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
          TestLLM.text("Done.", "after"),
        )
        yield* h.prompt("write the file")
        expect({ input, written: written.read() }).toEqual({ input, written: refused ? undefined : "new" })
        const { db } = yield* Database.Service
        expect(
          yield* db
            .select()
            .from(PromptStartTable)
            .where(eq(PromptStartTable.session_id, h.sessionID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
      }
    }),
  )
})

describe("the check at the end of a turn", () => {
  /** CPP's check for what the chat is on, as the small server words it. */
  const line = (item: { readonly id: string; readonly title: string }) =>
    `Task check (fake): [${item.id}] ${item.title}.`

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
      // The step after it got it at the end of the chat, after what came before as it was sent.
      const [, second, third] = h.requests()
      expect(h.requests()).toHaveLength(4)
      expect(JSON.stringify(third?.messages.at(-1))).toContain("Task check (fake):")
      expect(JSON.stringify(third?.messages.slice(0, second?.messages.length))).toBe(JSON.stringify(second?.messages))
      expect(written.read()).toBe("newer")
    }),
  )

  it.live("with task in Code Mode, comes just the same after a turn that changed something", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task", codemode: true })
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "bun test" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("run the tests")
      expect((yield* h.checks()).map((message) => message.type === "synthetic" && message.text)).toEqual([
        line(h.task!),
      ])
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

  it.live("a task call inside a Code Mode script counts, so the turn gets no check", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task", codemode: true })
      yield* h.llm.push(
        TestLLM.toolCall("call-shell", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-exec", "execute", {
          code: `try { await tools.task({ id: ${JSON.stringify(h.task!.id)} }) } catch (error) {}\nreturn "called"`,
        }),
        TestLLM.text("Ran and looked.", "ran"),
      )
      yield* h.prompt("run the tests and look at the task")
      expect(yield* h.checks()).toEqual([])
    }),
  )

  it.live("a goal made inside a Code Mode script is no task call, so the turn still gets its check", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task", codemode: true })
      yield* h.llm.push(
        TestLLM.toolCall("call-shell", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-exec", "execute", {
          code: `try { await tools.task({ kind: "goal", title: "Task tool improvements" }) } catch (error) {}\nreturn "made"`,
        }),
        TestLLM.text("Ran.", "ran"),
        TestLLM.text("It goes on.", "goes-on"),
      )
      yield* h.prompt("run the tests and note the goal")
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

  // The load check of 0.0.40: a read at the end of every turn waited behind the other chats' writes, the 95th
  // percentile turn +24 % with 50 chats at once.
  it.live("reads the chat only after a turn that called a tool that changes something", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      const read = () => reads.filter((id) => id === h.sessionID).length
      // The first turn this openforge sees: it may have changed something before a restart, so it is read.
      yield* h.llm.push(TestLLM.text("Hello.", "hello"))
      yield* h.prompt("hello")
      expect(read()).toBe(1)
      yield* h.llm.push(TestLLM.text("Nothing to change.", "nothing"))
      yield* h.prompt("anything to change?")
      expect(read()).toBe(1)
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "bun test" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("run the tests")
      expect(read()).toBe(2)
      expect(yield* h.checks()).toHaveLength(1)
    }),
  )

  it.live("names what CPP names: the chat's subtask once it is active, in CPP's words", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "subtask", subtaskBy: "self" })
      yield* activate(server, h.project, h.subtask!.id)
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("go on")
      expect((yield* h.checks()).map((message) => message.type === "synthetic" && message.text)).toEqual([
        line(h.subtask!),
      ])
      expect(
        server.calls().filter((call) => call.method === "GET" && call.path === `/pacer/v1/memory/${h.project}/chat`)[0]
          ?.pacer,
      ).toMatchObject({ "x-pacer-agent": "build", "x-pacer-chat": h.sessionID })
    }),
  )

  it.live(
    "none while CPP names none, on a server that serves no memory tools, or for a chat without the task tool",
    () =>
      Effect.gen(function* () {
        for (const input of [
          // Its subtask, the one it is on, is still todo: CPP answers no check.
          { inside: "subtask" },
          { inside: "task", catalog: catalogOf(true, { prompt: false, tools: false }) },
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
        request.method === "GET" && request.path.endsWith("/chat")
          ? Response.json({ error: { type: "internal", message: "boom" } }, { status: 500 })
          : server.pass(request)
      yield* h.llm.push(TestLLM.toolCall("call-shell", "shell", { command: "ls" }), TestLLM.text("Ran.", "ran"))
      yield* h.prompt("go on")
      expect(yield* h.checks()).toEqual([])
      expect(h.requests()).toHaveLength(2)
      expect(server.calls().filter((call) => call.path === `/pacer/v1/memory/${h.project}/chat`)).toHaveLength(1)
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

// Goals (the workspace's reference `docs/reference/goals-board-api.md`, "The task tool"): the tool's `kind` and `goal`
// go to CPP as they are; making a goal never puts the chat inside anything and is no task call for the check, a task
// made in a goal puts the chat inside it as any task, and moving a task to a goal leaves the chat where it was.
describe("goals", () => {
  const goal = "g4k2m8q1z7xa"
  /** CPP's answer to making a goal; even one that named a place would not move the chat. */
  const goals = (request: Parameters<NonNullable<typeof server.control.answer>>[0]) =>
    request.method === "POST" && request.path === "/pacer/v1/tools/task" && MemoryTask.promotion("task", request.body)
      ? // A task turned into a goal: the chat that was inside it is in no task now (the later items' spec, 10).
        Response.json({
          text: `[${request.body.id}] is a goal now; its steps are its tasks.`,
          data: [{ goal: { id: request.body.id, title: "Fix the typo", kind: "goal" } }],
          error: null,
          metadata: { id: request.body.id },
          place: null,
        })
      : request.method === "POST" &&
          request.path === "/pacer/v1/tools/task" &&
          MemoryTask.goalCall("task", request.body)
        ? Response.json({
            text: `Made goal ${goal} (fake).`,
            data: null,
            error: null,
            metadata: { id: goal },
            place: { task: goal, subtask: null },
          })
        : server.pass(request)
  /** The bodies of the chat's task calls as CPP got them. */
  const sent = () =>
    server.received.filter((item) => item.path === "/pacer/v1/tools/task").map((item) => item.body as unknown)
  const metadataOf = (h: Effect.Success<ReturnType<typeof setup>>) =>
    h.session.get(h.sessionID).pipe(Effect.map((session) => session.metadata))

  it.live("making a goal never puts the chat inside it: an edit after it is still refused", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      server.control.answer = goals
      const before = sent().length
      const written = file("goal.txt")
      const made = { kind: "goal", title: "Task tool improvements", description: "Done when leads see each other" }
      yield* h.llm.push(
        TestLLM.toolCall("call-goal", "task", made),
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("I make a task next.", "after"),
      )
      yield* h.prompt("plan the goal")
      expect(yield* h.results()).toEqual([
        { name: "task", status: "completed", error: undefined },
        { name: "write", status: "error", error: refused },
      ])
      expect(written.read()).toBeUndefined()
      expect(sent().slice(before)).toEqual([made])
      expect((yield* metadataOf(h))?.memory).toBeUndefined()
    }),
  )

  it.live("a task made in a goal puts the chat inside it, and the edit goes ahead", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      server.control.answer = goals
      const before = sent().length
      const written = file("in-goal.txt")
      const made = { title: "Board UI", goal, subtasks: [{ title: "The row" }] }
      yield* h.llm.push(
        TestLLM.toolCall("call-task", "task", made),
        TestLLM.toolCall("call-write", "write", { path: written.name, content: "new" }),
        TestLLM.text("Written.", "after"),
      )
      yield* h.prompt("build the board")
      expect(yield* h.results()).toEqual([
        { name: "task", status: "completed", error: undefined },
        { name: "write", status: "completed", error: undefined },
      ])
      expect(written.read()).toBe("new")
      expect(sent().slice(before)).toEqual([made])
      const place = server.store.placeOf(key, PacerSessionID.make(h.sessionID))
      expect(place?.task).toBeString()
      expect((yield* metadataOf(h))?.memory).toEqual({ task: place!.task, subtask: place!.subtask! })
    }),
  )

  it.live("making a goal is no task call for the check: a turn that changed something still gets one", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      server.control.answer = goals
      yield* h.llm.push(
        TestLLM.toolCall("call-shell", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-goal", "task", { kind: "goal", title: "Task tool improvements" }),
        TestLLM.text("Ran.", "ran"),
        TestLLM.text("It goes on.", "goes-on"),
      )
      yield* h.prompt("run the tests and note the goal")
      expect(yield* h.checks()).toHaveLength(1)
      expect((yield* metadataOf(h))?.memory).toEqual({ task: h.task!.id })
    }),
  )

  // The later items (workspace reference `docs/reference/task-system-later-api.md`, "openforge"): only a goal made from
  // nothing is the goal call; turning a task into a goal moves the chat as CPP's place says, and is a task call.
  it.live("turning a task into a goal moves the chat as CPP says, counts as the task call, and names the goal", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      server.control.answer = goals
      const before = sent().length
      const promoted = { id: h.task!.id, kind: "goal" }
      yield* h.llm.push(
        TestLLM.toolCall("call-shell", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-promote", "task", promoted),
        TestLLM.text("Promoted.", "promoted"),
      )
      yield* h.prompt("run the tests and make the task a goal")
      expect(sent().slice(before)).toEqual([promoted])
      expect(yield* h.checks()).toEqual([])
      expect((yield* metadataOf(h))?.memory).toBeUndefined()
      const messages = yield* h.session.messages({ sessionID: h.sessionID, order: "asc" })
      const call = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "call-promote")
      expect(
        call?.type === "tool" && call.state.status === "completed" ? call.state.metadata : undefined,
      ).toMatchObject({
        id: h.task!.id,
        title: "Fix the typo",
      })
    }),
  )

  it.live("moving a task to a goal is an edit: the chat stays where it was, and it counts as the task call", () =>
    Effect.gen(function* () {
      const h = yield* setup({ inside: "task" })
      server.control.answer = goals
      const before = sent().length
      yield* h.llm.push(
        TestLLM.toolCall("call-shell", "shell", { command: "bun test" }),
        TestLLM.toolCall("call-move", "task", { id: h.task!.id, goal }),
        TestLLM.text("Moved.", "moved"),
      )
      yield* h.prompt("run the tests and move the task")
      expect(yield* h.checks()).toEqual([])
      expect(sent().slice(before)).toEqual([{ id: h.task!.id, goal }])
      expect((yield* metadataOf(h))?.memory).toEqual({ task: h.task!.id })
      expect(server.store.placeOf(key, PacerSessionID.make(h.sessionID))).toEqual({ task: h.task!.id, subtask: null })
    }),
  )
})
