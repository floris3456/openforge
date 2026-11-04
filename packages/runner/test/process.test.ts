import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { RunnerClient } from "../src/client.js"
import { RunnerLock } from "../src/lock.js"
import { RunnerPaths } from "../src/paths.js"
import { alive, command, folder, run } from "./fixture/runner.js"

const serve = [process.execPath, path.join(import.meta.dir, "fixture", "serve.ts")]

const parent = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1])

describe("runner process", () => {
  test("starts detached, and when it dies its commands keep running and its client sees it lost", async () => {
    await using directory = await folder()
    const runner = path.join(directory.path, "runner")
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connectOrStart(runner, RunnerClient.launch([...serve, runner], runner))
        expect(connection.pid).not.toBe(process.pid)
        if (process.platform === "linux") expect(parent(connection.pid)).not.toBe(process.pid)
        expect(yield* Effect.promise(() => RunnerLock.held(RunnerPaths.lock(runner)))).toBe(true)
        const started = yield* connection.start(command(directory.path, "sleep 30"))
        process.kill(connection.pid, "SIGKILL")
        expect(yield* connection.closed).toBe("lost")
        expect(alive(started.command.pgid)).toBe(true)
        expect(yield* Effect.promise(() => RunnerLock.held(RunnerPaths.lock(runner)))).toBe(false)
        process.kill(-started.command.pgid, "SIGKILL")
      }),
    )
  })

  test("asked to stop, it stops its commands, writes their exits and says goodbye", async () => {
    await using directory = await folder()
    const runner = path.join(directory.path, "runner")
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connectOrStart(
          runner,
          RunnerClient.launch([...serve, runner, "test", "200"], runner),
        )
        const input = command(directory.path, "trap '' TERM; while :; do sleep 0.05; done")
        const started = yield* connection.start(input)
        const exit = yield* connection
          .watch(input.id, { offset: 0, output: false })
          .pipe(Stream.runLast, Effect.forkScoped({ startImmediately: true }))
        process.kill(connection.pid, "SIGTERM")
        const last = yield* Fiber.join(exit)
        expect(last._tag === "Some" && last.value).toMatchObject({ type: "exit", exit: { status: "killed", signal: "SIGKILL" } })
        expect(yield* connection.closed).toBe("bye")
        expect(fs.existsSync(RunnerPaths.exit(input.output))).toBe(true)
        expect(alive(started.command.pgid)).toBe(false)
      }),
    )
  })
})
