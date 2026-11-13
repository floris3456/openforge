// What `SessionPromptStart.resolve` costs a warm step with nothing changed, over the default tool registry as the
// service builds it for a location (its plugins activated, Code Mode's `execute` included), in a database of its own.
// Each round takes a fresh snapshot as a step does; only `resolve` is timed. Fails over the budget.
//   bun run script/benchmark-prompt-start.ts [--rounds 5000] [--budget-us 15]
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Logger } from "effect"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "../src/agent"
import { Bus } from "../src/bus"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { ModelsDev } from "../src/models-dev"
import { Plugin } from "../src/plugin"
import { SdkPlugins } from "../src/plugin/sdk"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionPromptStart } from "../src/session/prompt-start"
import { SessionTable } from "../src/session/sql"
import { Tool } from "../src/tool"

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : Number(args[index + 1])
}
const rounds = option("--rounds", 5_000)
const budget = option("--budget-us", 15)

const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "prompt-start-bench-"))
const directory = path.join(root, "project")
await Bun.write(path.join(directory, "README.md"), "bench\n")
const replacements = [
  Global.node.replace(
    Global.layerWith({
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "cache", "bin"),
      log: path.join(root, "data", "log"),
      repos: path.join(root, "data", "repos"),
    }),
  ),
  ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
]
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]),
  replacements,
)

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessionID = SessionSchema.ID.make("ses_prompt_start_bench")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "bench", directory, title: "t", version: "t" })
    .run()
    .pipe(Effect.orDie)

  return yield* Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* plugins.awaitActivation
    const registry = yield* Tool.Service
    // The module as the graph builds it, over this run's database, bus and the location's config.
    const starts = Context.get(
      yield* Layer.build(
        AppNodeBuilder.build(SessionPromptStart.node, [
          ...replacements,
          Database.node.replace(Layer.succeed(Database.Service, yield* Database.Service)),
          Bus.node.replace(Layer.succeed(Bus.Service, yield* Bus.Service)),
          Config.node.replace(Layer.succeed(Config.Service, yield* Config.Service)),
          Location.node.replace(Layer.succeed(Location.Service, yield* Location.Service)),
        ]),
      ),
      SessionPromptStart.Service,
    )
    const agents = yield* Agent.Service
    const agent = yield* agents.get(Agent.ID.make("build"))
    const input = (definitions: Tool.Snapshot["definitions"]) => ({
      kind: "primary" as const,
      sessionID,
      agent: Agent.ID.make("build"),
      // A cache time long enough that the chat stays warm through the run.
      model: { providerID: "bench", id: "bench-model" },
      ttl: "1d",
      system: agent?.system,
      definitions: Effect.succeed(definitions),
    })
    const first = yield* registry.snapshot()
    const bytes = JSON.stringify(first.definitions).length
    const again = yield* registry.snapshot()
    const shared = again.definitions.every((definition, index) => definition === first.definitions[index])
    // The cold point that records the start.
    yield* starts.resolve(input(first.definitions))
    const round = Effect.gen(function* () {
      const snapshot = yield* registry.snapshot()
      const begun = performance.now()
      const start = yield* starts.resolve(input(snapshot.definitions))
      const spent = performance.now() - begun
      if ("reminder" in start && start.reminder) return yield* Effect.die(new Error("a reminder on an unchanged step"))
      return spent
    })
    for (let index = 0; index < 500; index++) yield* round
    const samples: number[] = []
    for (let index = 0; index < rounds; index++) samples.push(yield* round)
    const sorted = samples.toSorted((left, right) => left - right)
    const mean = (samples.reduce((total, sample) => total + sample, 0) / samples.length) * 1_000
    const p50 = (sorted[Math.floor(sorted.length / 2)] ?? 0) * 1_000
    const p95 = (sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 1_000
    console.log(
      `tools: ${first.definitions.length} (${first.definitions.map((tool) => tool.name).join(", ")}), ${bytes} bytes of JSON; ${shared ? "the same objects" : "new objects"} in each step's snapshot`,
    )
    console.log(
      `resolve, warm step, nothing changed: mean ${mean.toFixed(1)} µs  p50 ${p50.toFixed(1)} µs  p95 ${p95.toFixed(1)} µs  (${rounds} rounds)`,
    )
    const { db } = yield* Database.Service
    const begun = performance.now()
    for (let index = 0; index < rounds; index++) yield* SessionPromptStart.read(db, sessionID)
    console.log(`  of which reading the record: ${(((performance.now() - begun) / rounds) * 1_000).toFixed(1)} µs`)
    console.log(`${mean <= budget ? "PASS" : "FAIL"}: budget ${budget} µs per step`)
    return mean <= budget
  }).pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
  )
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([])))

const passed = await Effect.runPromise(program).finally(() => rm(root, { recursive: true, force: true }))
process.exit(passed ? 0 : 1)
