import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Form } from "@opencode/core/form"
import { Image } from "@opencode/core/image"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema, Stream } from "effect"
import { imagePassthrough } from "./lib/image"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { registerToolPlugin, toolIdentity } from "./lib/tool"

// Workspace task qty37j716xs8: a subagent (a chat with a parent, whatever agent it runs) is offered no question tool,
// which would put its question on the person's screen; its instructions tell it to put the question in its reply to
// its lead. A top-level chat keeps the tool.

const lead = Session.ID.make("ses_questions_lead")
const helper = Session.ID.make("ses_questions_helper")
const asked: Form.CreateInput[] = []

const questionTool = makeLocationNode({
  name: "test/subagent-questions-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* registerToolPlugin(QuestionTool.Plugin)
      const registry = yield* Tool.Service
      yield* registry.transform((editor) =>
        editor.add({
          name: "echo",
          options: { codemode: false },
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
        }),
      )
    }),
  ),
  deps: [Tool.node, Permission.node, Form.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      SessionContext.node,
      PluginHooks.node,
      Tool.node,
      questionTool,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Config.node.replace(Config.testLayer()),
      Image.node.replace(imagePassthrough),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Form.node.replace(
        Layer.mock(Form.Service, {
          ask: (input: Form.CreateInput) =>
            Effect.sync((): Form.TerminalState => {
              asked.push(input)
              return { status: "answered", answer: { q0: "Yes" } }
            }),
        }),
      ),
      SessionRunnerModel.node.replace(
        Layer.mock(SessionRunnerModel.Service)({
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "test", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 100_000, output: 8_000 },
                },
              ),
            ),
        }),
      ),
      InstructionBuiltIns.node.replace(
        Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, {
          project: false,
          global: false,
          claude: false,
          load: () => Effect.succeed(Instructions.empty),
        }),
      ),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(
        Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      PluginSupervisor.node.replace(Layer.empty),
      PacerTools.node.replace(
        Layer.succeed(
          PacerTools.Service,
          PacerTools.Service.of({
            list: () => Effect.succeed(undefined),
            seen: () => {},
            cold: () => {},
            call: () => Effect.die(new Error("unused")),
            upload: () => Effect.void,
            reviewItem: () => Effect.die(new Error("unused")),
            download: () => Effect.die(new Error("unused")),
            known: () => Effect.succeed(new Map()),
            knownChanges: () => Stream.empty,
            holds: () => undefined,
            held: () => undefined,
          }),
        ),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

/** A lead on the build agent and its helper, on the build agent too, which allows questions. */
const chats = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const projects = yield* Project.Service
  const project = (yield* projects.resolve(AbsolutePath.make("/project"))).id
  for (const [id, parent] of [
    [lead, undefined],
    [helper, lead],
  ] as const)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        parent_id: parent,
        project_id: project,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent: Agent.ID.make("build"),
      })
      .run()
      .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  return yield* SessionContext.Service
})

const names = (selection: SessionContext.Selection) => selection.tools.definitions.map((tool) => tool.name)

/** The instructions a chat starts with, as the model reads them. */
const instructions = (selection: SessionContext.Selection) =>
  Instructions.read(selection.instructions).pipe(
    Effect.map((observed) =>
      Instructions.join(
        Instructions.renderInitial(
          selection.instructions,
          Object.fromEntries(
            observed
              .filter(
                (entry): entry is { readonly key: Instructions.Key; readonly value: Schema.Json } =>
                  entry.value !== Instructions.unavailable && entry.value !== Instructions.removed,
              )
              .map((entry) => [entry.key, entry.value]),
          ),
        ),
      ),
    ),
  )

const question = {
  questions: [
    {
      question: "Read older chats' badges from where?",
      header: "Badges",
      options: [{ label: "Here", description: "Here" }],
    },
  ],
}

describe("a subagent's questions", () => {
  it.effect("a subagent's tool list holds no question tool, whatever agent it runs", () =>
    Effect.gen(function* () {
      const context = yield* chats
      const tools = names(yield* context.select(helper))
      expect(tools).toContain("echo")
      expect(tools).not.toContain(QuestionTool.name)
    }),
  )

  it.effect("a top-level chat's tool list keeps the question tool", () =>
    Effect.gen(function* () {
      const context = yield* chats
      expect(names(yield* context.select(lead))).toContain(QuestionTool.name)
    }),
  )

  it.effect("a subagent's instructions say to put a question for its lead in its reply; a lead's do not", () =>
    Effect.gen(function* () {
      const context = yield* chats
      const said = yield* instructions(yield* context.select(helper))
      expect(said).toMatch(/put (a|any|your) question for your lead in your reply/i)
      expect(yield* instructions(yield* context.select(lead))).not.toMatch(/your lead/i)
    }),
  )

  it.effect("a subagent's call of the question tool, as a start recorded earlier still offers it, asks nobody", () =>
    Effect.gen(function* () {
      const context = yield* chats
      const leadTools = (yield* context.select(lead)).tools
      const recorded = leadTools.definitions.find((tool) => tool.name === QuestionTool.name)!
      const tools = (yield* context.select(helper)).tools
      asked.length = 0
      const failure = yield* tools
        .execute({
          sessionID: helper,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: QuestionTool.name, input: question },
          definitions: new Map([
            ...tools.definitions.map((tool) => [tool.name, tool] as const),
            [QuestionTool.name, recorded] as const,
          ]),
        })
        .pipe(Effect.flip)
      expect(failure.message).toContain(QuestionTool.name)
      expect(asked).toEqual([])
    }),
  )
})
