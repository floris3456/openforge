// What naming a chat's project to CLIProxyPacer adds to a model request: `PacerProject.chat` and the headers it gives
// `PacerHeaders.make`, against `PacerHeaders.make` alone, for a location resolved from a git repository with a remote
// in a database of its own. Config's entries are one array until it reloads, as the service's are. Fails over the budget.
//   bun run script/benchmark-pacer-project.ts [--rounds 100000] [--budget-us 50]
import { $ } from "bun"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionID } from "@opencode/schema/session-id"
import { Config } from "../src/config"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Location } from "../src/location"
import { PacerHeaders } from "../src/pacer/headers"
import { PacerProject } from "../src/pacer/project"
import { AbsolutePath } from "../src/schema"

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : Number(args[index + 1])
}
const rounds = option("--rounds", 100_000)
const budget = option("--budget-us", 50)

const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "pacer-project-bench-"))
const directory = path.join(root, "café-repo")
await Bun.write(path.join(directory, "README.md"), "bench\n")
await $`git init -q`.cwd(directory).quiet()
await $`git remote add origin ${"git@github.com:owner/café-repo.git"}`.cwd(directory).quiet()
const entries: Effect.Success<ReturnType<Config.Interface["entries"]>> = []
const layer = AppNodeBuilder.build(LayerNode.group([PacerProject.node, Location.node]), [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(directory) })),
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
  Config.node.replace(Layer.mock(Config.Service, { entries: () => Effect.succeed(entries) })),
])

const program = Effect.gen(function* () {
  const location = yield* Location.Service
  const projects = yield* PacerProject.Service
  const sessionID = SessionID.make("ses_bench_pacer_project")
  const request = { providerID: "cliproxypacer", kind: "primary", sessionID, auto: true } as const
  const named = PacerHeaders.make({ ...request, project: (yield* projects.chat(location.project.id)).headers })
  if (named["X-Pacer-Project"] !== location.project.id) throw new Error(`no project named: ${JSON.stringify(named)}`)

  const time = Effect.fnUntraced(function* (step: Effect.Effect<unknown>) {
    const samples = new Float64Array(rounds)
    for (let i = 0; i < rounds; i++) {
      const start = Bun.nanoseconds()
      yield* step
      samples[i] = Bun.nanoseconds() - start
    }
    samples.sort()
    const sum = samples.reduce((total, value) => total + value, 0)
    return {
      mean: sum / rounds / 1000,
      median: samples[rounds >> 1]! / 1000,
      p99: samples[Math.floor(rounds * 0.99)]! / 1000,
    }
  })
  const without = Effect.sync(() => PacerHeaders.make(request))
  const withProject = projects
    .chat(location.project.id)
    .pipe(Effect.map((chat) => PacerHeaders.make({ ...request, project: chat.headers })))
  // Warm both paths before measuring.
  yield* time(without)
  yield* time(withProject)
  const base = yield* time(without)
  const full = yield* time(withProject)
  const added = { mean: full.mean - base.mean, median: full.median - base.median, p99: full.p99 - base.p99 }
  const format = (value: number) => `${value.toFixed(3)} µs`
  console.log(`location ${location.directory}, remote ${location.remote}`)
  console.log(`headers ${JSON.stringify(named)}`)
  console.log(`rounds ${rounds}`)
  console.log(`without project: mean ${format(base.mean)}, median ${format(base.median)}, p99 ${format(base.p99)}`)
  console.log(`with project:    mean ${format(full.mean)}, median ${format(full.median)}, p99 ${format(full.p99)}`)
  console.log(`added:           mean ${format(added.mean)}, median ${format(added.median)}, p99 ${format(added.p99)}`)
  if (added.mean > budget) throw new Error(`added cost ${format(added.mean)} is over the budget of ${budget} µs`)
  console.log(`within the budget of ${budget} µs`)
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(Logger.layer([])))).finally(() =>
  rm(root, { recursive: true, force: true }),
)
