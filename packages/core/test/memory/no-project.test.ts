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
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { MemoryClient } from "@opencode/core/memory/client"
import { MemoryTexts } from "@opencode/core/memory/texts"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
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
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { initRepo } from "../fixture/git"
import { promptLocationNode } from "../fixture/prompt-location"
import { it } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { codeModeListings } from "../lib/tool"
import { catalogOf, codeModeList, endpointAt, pacerToolsNode, poll, primeTools, startProxied } from "./fixture"

// The tools of a chat in no project (the workspace's spec `docs/specs/cpp-projects.md`, "What a project is": a chat
// outside git "names none, makes none and gets no memory and no task tools"), through the real runner over the small
// memory server, beside a chat of a git repository that has them: direct, as CLIProxyPacer places them by default, and
// with `task` in Code Mode (`tools.task_codemode`), where the catalog is the chat's list's too.

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "in-git-")))
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "outside-git-")))
await initRepo(repo)
const server = startProxied()
afterAll(async () => {
  await server.stop()
  for (const directory of [repo, outside]) fs.rmSync(directory, { recursive: true, force: true })
})

const endpointRef = Effect.runSync(SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointAt(server.origin)))
const catalogRef = Effect.runSync(
  SubscriptionRef.make<PacerModels.Catalog | undefined>(catalogOf(true, { prompt: false })),
)
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
/** A direct tool and a Code Mode one of openforge's own, beside CPP's. */
const own = makeLocationNode({
  name: "test/no-project-tools",
  layer: Layer.effectDiscard(
    Tool.Service.use((registry) =>
      registry.transform((editor) => {
        editor.add({
          name: "echo",
          description: "Echo text",
          options: { codemode: false },
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
        })
        editor.add({
          name: "weather",
          description: "Today's weather",
          options: { codemode: true },
          input: Schema.Struct({ city: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ city }) => Effect.succeed({ output: { text: city }, content: city }),
        })
      }),
    ),
  ),
  deps: [Tool.node],
})
const memoryTools = pacerToolsNode("test/no-project-pacer-tools")

/** The runner's graph for chats whose folder is `directory`, its project resolved as openforge resolves it. */
const layerAt = (directory: string) => {
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
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(directory) })),
    Config.node.replace(Config.testLayer()),
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
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
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      Model.node,
      PluginHooks.node,
      Tool.node,
      own,
      memoryTools,
      PacerTools.node,
      MemoryTexts.node,
      Config.node,
      Location.node,
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
}

/**
 * A new chat of the folder `directory`, in the project openforge resolves for it, after an earlier chat at the
 * endpoint read the memory tools (so they are registered, as openforge registers them): its first request, and the
 * listing of `task` in the registry's Code Mode catalog, if any.
 */
const firstRequest = (directory: string) =>
  Effect.gen(function* () {
    yield* primeTools(`elsewhere-${crypto.randomUUID().slice(0, 8)}`)
    const texts = yield* MemoryTexts.Service
    yield* poll("memory's texts are kept", () => Effect.runSync(texts.get()) !== undefined)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      })
    })
    const location = yield* Location.Service
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: location.project.id, worktree: location.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessionID = Session.ID.make(`ses_noproject_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: location.project.id,
        // On CLIProxyPacer, whose list the chat reads before its instructions.
        model: { id: "fake-model", providerID: PacerEndpoint.id },
        slug: sessionID,
        directory: location.directory,
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const session = yield* Session.Service
    const started = requests.length
    yield* session.prompt({ sessionID, text: "hello", resume: false }).pipe(Effect.andThen(session.resume(sessionID)))
    const registry = yield* Tool.Service
    const catalog = (yield* registry.snapshot([])).codeModeCatalog
    return {
      git: location.vcs?.type === "git",
      request: requests[started],
      task: catalog && codeModeListings(catalog).find((entry) => entry.path === "task")?.line,
    }
  }).pipe(Effect.provide(layerAt(directory)), Effect.scoped)

/** The request's direct tools but Code Mode's own. */
const names = (request: LLMRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.name).filter((name) => name !== "execute")
const memoryNames = ["forget", "recall", "remember", "task"]
/** The Code Mode catalog the request's system prompt holds, from its heading to its last line. */
const catalogText = (request: LLMRequest | undefined) => {
  const system = (request?.system ?? []).map((part) => part.text).join("\n\n")
  return /# Code Mode\n[\s\S]*?## Code Mode tools \(call only inside `execute`\)\n\n(?:- [^\n]*(?:\n(?!\n)[^\n]*)*)/.exec(
    system,
  )?.[0]
}

describe("a chat in no project", () => {
  it.live("gets no memory tools where they are direct; its other tools are a git chat's, byte for byte", () =>
    Effect.gen(function* () {
      server.reset()
      Effect.runSync(SubscriptionRef.set(catalogRef, catalogOf(true, { prompt: false })))
      const inGit = yield* firstRequest(repo)
      const outsideGit = yield* firstRequest(outside)
      expect([inGit.git, outsideGit.git]).toEqual([true, false])

      expect(names(inGit.request).toSorted()).toEqual(["echo", ...memoryNames])
      expect(names(outsideGit.request)).toEqual(["echo"])
      expect(outsideGit.request?.tools).toEqual(inGit.request?.tools.filter((tool) => !memoryNames.includes(tool.name)))
      expect(catalogText(outsideGit.request)).toBe(catalogText(inGit.request))
    }),
  )

  it.live("gets no task tool where it is Code Mode's; the rest of its catalog is a git chat's, byte for byte", () =>
    Effect.gen(function* () {
      server.reset()
      // CLIProxyPacer's `tools.task_codemode`: its capabilities and its lists say `task` runs in Code Mode.
      server.control.answer = codeModeList(server, ["task"])
      Effect.runSync(SubscriptionRef.set(catalogRef, catalogOf(true, { prompt: false, codemode: ["task"] })))
      const inGit = yield* firstRequest(repo)
      const outsideGit = yield* firstRequest(outside)

      expect(names(inGit.request).toSorted()).toEqual(["echo", "forget", "recall", "remember"])
      expect(names(outsideGit.request)).toEqual(["echo"])
      expect(outsideGit.request?.tools).toEqual(inGit.request?.tools.filter((tool) => !memoryNames.includes(tool.name)))
      const listed = catalogText(inGit.request)
      expect(inGit.task).toBeDefined()
      expect(listed).toContain(`\n- task (1 tool)\n${inGit.task}`)
      expect(listed).toContain("weather")
      // Its catalog is the git chat's without `task`'s lines.
      expect(catalogText(outsideGit.request)).toBe(listed?.replace(`\n- task (1 tool)\n${inGit.task}`, ""))
    }),
  )
})
