import { describe, expect } from "bun:test"
import { LanguageModel, ToolDefinition } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PacerInstructions } from "@opencode/core/pacer/instructions"
import { PacerTools } from "@opencode/core/pacer/tools"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

// CLIProxyPacer's instructions for agents (workspace spec `docs/specs/codemode-pinning.md`, item 3): the chat's own
// list carries one text for the server, put in its instructions as its own section; a change arrives as an update and
// becomes the chat's baseline at its next cold point, as every other instruction source does.

const sessionID = SessionSchema.ID.make("ses_pacer_instructions")

/** A chat's held list: the instructions, and nothing else this test asks of it. */
const list = (instructions?: { readonly text: string; readonly version: string }): PacerTools.List => ({
  version: "7e57000000000001",
  definitions: [],
  byName: new Map(),
  meta: new Map(),
  ...(instructions === undefined ? {} : { instructions }),
})

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "pacer-instructions-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  },
)
const models = Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.succeed(model) })
const builtins = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const discovery = Layer.mock(InstructionDiscovery.Service, {
  project: false,
  global: false,
  claude: false,
  load: () => Effect.succeed(Instructions.empty),
})
const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const tools = Layer.mock(Tool.Service, {
  snapshot: () =>
    Effect.succeed({
      definitions: [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })],
      execute: () => Effect.die(new Error("unused")),
    }),
  transform: () => Effect.die(new Error("unused")),
})

/** What the chat holds, as `PacerTools.held` answers it: a test sets it before each selection. */
let held: PacerTools.List | undefined
const pacer = Layer.succeed(
  PacerTools.Service,
  PacerTools.Service.of({
    list: () => Effect.succeed(undefined),
    seen: () => {},
    cold: () => {},
    call: () => Effect.die(new Error("unused")),
    upload: () => Effect.void,
    known: () => Effect.succeed(new Map()),
    knownChanges: () => Stream.empty,
    holds: () => undefined,
    held: () => held,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(builtins),
      InstructionDiscovery.node.replace(discovery),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(tools),
      PacerTools.node.replace(pacer),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const agents = yield* Agent.Service
  const projects = yield* Project.Service
  const context = yield* SessionContext.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
      slug: "pacer-instructions",
      directory: "/project",
      title: "Pacer instructions",
      version: "test",
      agent: Agent.ID.make("build"),
    })
    .run()
    .pipe(Effect.orDie)
  return { db, bus, context }
})

/** The system prompt's instruction parts for the selection, as a request's start renders them. */
const system = (db: Database.Interface["db"], selection: SessionContext.Selection) =>
  InstructionState.initial(db, sessionID, selection.instructions).pipe(
    Effect.map((parts) => parts.map((part) => part.text).join("\n\n")),
  )

/** The text of each instructions update the model was told, in order. */
const updates = (db: Database.Interface["db"]) =>
  db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.type, "session.instructions.updated.2"))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
    .pipe(Effect.map((rows) => rows.flatMap((row) => (row.data.text === undefined ? [] : [row.data.text as string]))))

const text = "CLIProxyPacer holds the person's memory and tasks. Its tools are called through execute."

describe("PacerInstructions.make", () => {
  it.effect("renders the chat's text as its section, and a new text as its replacement", () =>
    Effect.gen(function* () {
      const initial = yield* readInitial(PacerInstructions.make(list({ text, version: "1" })))
      expect(initial.text).toBe(text)
      const changed = yield* readUpdate(
        PacerInstructions.make(list({ text: "CLIProxyPacer's world, written again.", version: "2" })),
        initial,
      )
      expect(changed.text).toBe(
        "CLIProxyPacer's instructions have changed; these replace the earlier ones:\n\nCLIProxyPacer's world, written again.",
      )
    }),
  )

  it.effect("has no section without a list or without instructions, and says when a list loses them", () =>
    Effect.gen(function* () {
      expect((yield* readInitial(PacerInstructions.make(undefined))).text).toBe("")
      expect((yield* readInitial(PacerInstructions.make(list()))).text).toBe("")
      const initial = yield* readInitial(PacerInstructions.make(list({ text, version: "1" })))
      expect((yield* readUpdate(PacerInstructions.make(list()), initial)).text).toBe(
        "CLIProxyPacer's instructions no longer apply.",
      )
    }),
  )
})

describe("PacerInstructions in a chat's instructions", () => {
  it.effect("puts the chat's text in its system prompt", () =>
    Effect.gen(function* () {
      const { db, bus, context } = yield* setup
      held = list({ text, version: "1" })
      const selection = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, selection.instructions, sessionID)
      expect(yield* system(db, selection)).toBe(text)
      expect(yield* updates(db)).toEqual([])
    }),
  )

  it.effect("tells a warm chat about a new text as its update, and keeps the baseline it had", () =>
    Effect.gen(function* () {
      const { db, bus, context } = yield* setup
      held = list({ text, version: "1" })
      const first = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, first.instructions, sessionID)

      const next = "CLIProxyPacer's world, written again."
      held = list({ text: next, version: "2" })
      const second = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, second.instructions, sessionID)
      expect(yield* updates(db)).toEqual([
        `CLIProxyPacer's instructions have changed; these replace the earlier ones:\n\n${next}`,
      ])
      // A warm chat's start keeps the text it had; the new one becomes its baseline at its next cold point.
      expect(yield* system(db, second)).toBe(text)
      yield* InstructionState.rebase(db, bus, second.instructions, sessionID)
      expect(yield* system(db, second)).toBe(next)
    }),
  )

  it.effect("has nothing for a chat that holds no list, or one whose list carries no instructions", () =>
    Effect.gen(function* () {
      const { db, bus, context } = yield* setup
      held = undefined
      const none = yield* context.select(sessionID)
      expect(none.instructions.map((source) => source.key)).not.toContain("pacer/instructions")
      yield* InstructionState.prepare(db, bus, none.instructions, sessionID)
      expect(yield* system(db, none)).not.toContain("CLIProxyPacer")

      // A list that carries none has its source, which says nothing: no section, and no update either.
      held = list()
      const bare = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, bare.instructions, sessionID)
      expect(yield* system(db, bare)).not.toContain("CLIProxyPacer")
      expect(yield* updates(db)).toEqual([])
    }),
  )
})
