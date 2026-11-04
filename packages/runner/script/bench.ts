#!/usr/bin/env bun
// The tool runner's benchmarks from the v0.1.0 spec, on a runner in its own process as the service starts it:
// - start: median cost of starting a command through the runner over spawning it directly (at most 10 ms);
// - load: the runner's memory with 50 running commands (at most 80 MB);
// - output: a command printing 1 GB leaves a file of at most 8 MiB, and the runner's memory stays flat;
// - idle: once nothing runs, the runner exits after its grace period, so there is no runner process.
// Memory is the runner's whole resident set (rss) and the part that is its own (own: anonymous, not pages of the
// executable), sampled every 20 ms from outside.
// Usage: bun script/bench.ts [--binary <openforge>] [--runs <n>] [--output-bytes <n>] [--out <file.json>]
// Memory is read from /proc on Linux; on macOS `ps` gives only rss (own is NaN). Everything is written in a fresh
// folder under the temporary directory.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Effect, Fiber, Stream } from "effect"
import { RunnerClient } from "../src/client.js"
import { RunnerOutput } from "../src/output.js"
import type { RunnerProtocol } from "../src/protocol.js"

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    runs: { type: "string", default: "200" },
    "output-bytes": { type: "string", default: String(1024 ** 3) },
    out: { type: "string" },
  },
})
const runs = Number(values.runs)
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-bench-")))
const directory = path.join(root, "runner")
const argv = values.binary
  ? [values.binary, "runner", directory]
  : [process.execPath, path.join(import.meta.dir, "..", "test", "fixture", "serve.ts"), directory]
const env = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
)

let counter = 0
const command = (script: string): RunnerProtocol.Start => {
  const id = `sh_bench${String(++counter).padStart(8, "0")}`
  return {
    id,
    argv: ["/bin/sh", "-c", script],
    cwd: root,
    env,
    deadline: null,
    output: path.join(root, `${id}.out`),
    meta: { command: script },
  }
}

const round = (value: number) => Math.round(value * 100) / 100
const median = (samples: number[]) => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)]
const step = (name: string) => Effect.sync(() => process.stderr.write(`bench: ${name}\n`))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Memory = { rss: number; own: number }
const memory = (pid: number): Memory => {
  // macOS has no /proc: `ps` gives the resident set, not the part that is the runner's own.
  if (process.platform !== "linux") {
    const kb = Number(
      Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
        .stdout.toString()
        .trim(),
    )
    return { rss: round(kb / 1024), own: NaN }
  }
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? NaN) / 1024
  return { rss: round(field("VmRSS")), own: round(field("RssAnon")) }
}

// Runs `effect` while sampling the runner's memory: before, at its most, and after.
const sampled = <A, E, R>(pid: number, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = memory(pid)
    const max = { ...before }
    const take = () => {
      const now = memory(pid)
      max.rss = Math.max(max.rss, now.rss)
      max.own = Math.max(max.own, now.own)
    }
    const sampler = yield* Effect.sync(take).pipe(
      Effect.andThen(Effect.sleep("20 millis")),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )
    const value = yield* effect
    yield* Fiber.interrupt(sampler)
    take()
    return { value, memory: { before, max, after: memory(pid) } }
  })

const bench = Effect.gen(function* () {
  const connection = yield* RunnerClient.connectOrStart(directory, RunnerClient.launch(argv, directory))
  const runner = connection.pid
  const fresh = memory(runner)
  const settle = (id: string) =>
    connection.watch(id, { offset: 0, output: false }).pipe(
      Stream.filter((frame) => frame.type === "exit"),
      Stream.runHead,
    )

  yield* step("start")
  // Until the command runs, and until its exit is seen.
  const direct = { started: [] as number[], exited: [] as number[] }
  const through = { started: [] as number[], exited: [] as number[] }
  for (let run = 0; run < runs; run++) {
    const input = command("exit 0")
    const before = performance.now()
    const child = Bun.spawn([...input.argv], { cwd: root, env, stdout: Bun.file(input.output), stderr: "ignore" })
    direct.started.push(performance.now() - before)
    yield* Effect.promise(() => child.exited)
    direct.exited.push(performance.now() - before)

    const ours = command("exit 0")
    const start = performance.now()
    const started = yield* connection.start(ours)
    through.started.push(performance.now() - start)
    yield* settle(started.command.id)
    through.exited.push(performance.now() - start)
    yield* connection.signal(ours.id, "SIGKILL", { remove: true })
  }
  const start = {
    runs,
    medianMs: {
      direct: { started: round(median(direct.started)), exited: round(median(direct.exited)) },
      runner: { started: round(median(through.started)), exited: round(median(through.exited)) },
    },
    extraMs: {
      started: round(median(through.started) - median(direct.started)),
      exited: round(median(through.exited) - median(direct.exited)),
    },
  }

  yield* step("load")
  // 50 running commands, each watched for its output as a viewer would.
  const load = yield* sampled(
    runner,
    Effect.gen(function* () {
      const running = yield* Effect.forEach(Array.from({ length: 50 }), () =>
        connection.start(command("printf ready; sleep 60")),
      )
      const watches = yield* Effect.forEach(running, (started) =>
        connection
          .watch(started.command.id, { offset: 0, output: true, lag: RunnerOutput.CHUNK })
          .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true })),
      )
      yield* Effect.sleep("2 seconds")
      const steady = memory(runner)
      const listed = (yield* connection.list).filter((item) => !item.exit).length
      yield* Effect.forEach(running, (started) => connection.signal(started.command.id, "SIGKILL", { remove: true }))
      yield* Effect.forEach(watches, Fiber.interrupt)
      return { steady, listed }
    }),
  )

  yield* step("output")
  // 1 GB (or --output-bytes) through one command while a viewer follows it.
  const big = command(`yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c ${Number(values["output-bytes"])}`)
  const output = yield* sampled(
    runner,
    Effect.gen(function* () {
      const began = performance.now()
      yield* connection.start(big)
      let seen = 0
      const viewer = yield* connection.watch(big.id, { offset: 0, output: true, lag: RunnerOutput.CHUNK }).pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            if (frame.type === "output") seen += frame.data.length
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const exit = yield* settle(big.id)
      const seconds = round((performance.now() - began) / 1000)
      yield* Fiber.join(viewer)
      return { exit: exit._tag === "Some" && exit.value.type === "exit" ? exit.value.exit : undefined, seconds, seen }
    }),
  )
  const file = fs.statSync(big.output).size
  yield* connection.signal(big.id, "SIGKILL", { remove: true })

  yield* step("idle")
  // Once nothing runs, the runner exits after its grace period.
  const idleFrom = performance.now()
  const closed = yield* connection.closed
  while (alive(runner)) yield* Effect.sleep("20 millis")

  return {
    runner: {
      argv: argv.slice(0, -1),
      pid: runner,
      protocol: connection.protocol,
      version: connection.version,
      freshMB: fresh,
    },
    start,
    load: { commands: 50, running: load.value.listed, steadyMB: load.value.steady, ...load.memory },
    output: {
      bytes: output.value.exit?.size,
      status: output.value.exit?.status,
      seconds: output.value.seconds,
      file,
      limit: RunnerOutput.LIMIT,
      viewerBytes: output.value.seen,
      ...output.memory,
    },
    idle: { closed, exitedAfterSeconds: round((performance.now() - idleFrom) / 1000), runnerAlive: alive(runner) },
  }
})

const result = await Effect.runPromise(Effect.scoped(bench)).catch((cause: unknown) => {
  // Kept for its runner log.
  process.stderr.write(`bench: failed; its folder is kept: ${root}\n`)
  throw cause
})
fs.rmSync(root, { recursive: true, force: true })
const report = {
  date: new Date().toISOString(),
  host: os.hostname(),
  kernel: os.release(),
  bun: Bun.version,
  ...result,
}
console.log(JSON.stringify(report, null, 2))
if (values.out) fs.writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n")
