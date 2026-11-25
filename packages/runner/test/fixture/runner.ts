import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Scope } from "effect"
import { RunnerProtocol } from "../../src/protocol.js"
import { RunnerServer } from "../../src/server.js"

export async function folder() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-")))
  return {
    path: directory,
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

/** A runner in this process, shut down with its test even when the test fails, so no command outlives it. */
export async function serve(options: RunnerServer.Options) {
  const runner = await RunnerServer.serve(options)
  return Object.assign(runner, { [Symbol.asyncDispose]: () => runner.shutdown() })
}

/**
 * A runner's grace that passes only when the test says so. A runner whose grace has run out refuses later requests:
 * the service sends a refused start to the next runner (shell-runner.test.ts in core), but a test's bare connection
 * fails, and on a loaded host a test's set-up or its steps outrun any short grace.
 */
export function graceClock() {
  let pending: { readonly passed: () => void; readonly ms: number } | undefined
  return {
    schedule: (passed: () => void, ms: number) => {
      const wait = { passed, ms }
      pending = wait
      return () => {
        if (pending === wait) pending = undefined
      }
    },
    /** The grace a resting runner waits out; undefined while a command runs. */
    get waiting() {
      return pending?.ms
    },
    /** Ends the grace of a resting runner, which then exits as it does once its timer has run out. */
    pass() {
      const wait = pending
      if (!wait) throw new Error("the runner is not resting: a command still runs")
      pending = undefined
      wait.passed()
    },
  }
}

/**
 * A fresh folder whose `runner` folder has a runner in this process, whose grace passes only when the test calls
 * `rest()`. Both go with the test.
 */
export async function served(options: Partial<RunnerServer.Options> = {}) {
  const directory = await folder()
  const grace = graceClock()
  const runner = await serve({
    directory: path.join(directory.path, "runner"),
    version: "test",
    schedule: grace.schedule,
    ...options,
  })
  return {
    path: directory.path,
    runner,
    grace,
    /** Once nothing runs any more, the runner's grace passes and it exits. */
    async rest() {
      grace.pass()
      await runner.closed
    },
    async [Symbol.asyncDispose]() {
      await runner.shutdown()
      await directory[Symbol.asyncDispose]()
    },
  }
}

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

export const environment = () =>
  Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))

let counter = 0

export function command(directory: string, script: string, input: Partial<RunnerProtocol.Start> = {}) {
  const id = input.id ?? `sh_test${String(++counter).padStart(8, "0")}`
  return {
    id,
    argv: ["/bin/sh", "-c", script] as const,
    cwd: directory,
    env: environment(),
    deadline: null,
    output: path.join(directory, `${id}.out`),
    meta: { command: script },
    ...input,
  } satisfies RunnerProtocol.Start
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for `condition` without a fixed sleep; fails, naming `what`, once `timeout` milliseconds have passed. */
export async function until(condition: () => boolean | Promise<boolean>, what = "the condition", timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeout} ms`)
    await Bun.sleep(10)
  }
}
