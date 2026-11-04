import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Scope } from "effect"
import { RunnerProtocol } from "../../src/protocol.js"

export async function folder() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-")))
  return {
    path: directory,
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }),
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

/** Waits for `condition` without a fixed sleep, up to `timeout` milliseconds. */
export async function until(condition: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(10)
  }
}
