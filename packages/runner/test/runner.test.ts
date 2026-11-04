import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { RunnerClient } from "../src/client.js"
import { RunnerOutput } from "../src/output.js"
import { RunnerPaths } from "../src/paths.js"
import { RunnerProtocol } from "../src/protocol.js"
import { RunnerServer } from "../src/server.js"
import { alive, command, folder, run, until } from "./fixture/runner.js"

const collect = (connection: RunnerClient.Connection, id: string, offset = 0, output = true) =>
  connection.watch(id, { offset, output }).pipe(Stream.runCollect)

// Watches must be open before a command ends: the runner exits as soon as nothing runs.
const watching = (connection: RunnerClient.Connection, id: string, offset = 0, output = true) =>
  collect(connection, id, offset, output).pipe(Effect.forkScoped({ startImmediately: true }))

const text = (events: ReadonlyArray<RunnerClient.WatchEvent>) =>
  Buffer.concat(events.flatMap((event) => (event.type === "output" ? [event.data] : []))).toString()

const exitOf = (events: ReadonlyArray<RunnerClient.WatchEvent>) => {
  const last = events.at(-1)
  if (last?.type !== "exit") throw new Error("watch did not end with the exit")
  return last.exit
}

const readExit = (output: string) =>
  RunnerProtocol.decodeExit(fs.readFileSync(RunnerPaths.exit(output), "utf8")).pipe((decoded) => {
    if (decoded._tag === "None") throw new Error("invalid exit file")
    return decoded.value
  })

describe("runner", () => {
  test("starts a command, pushes its output from an offset and then its exit, and writes the exit file", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test" })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        expect(connection).toMatchObject({ protocol: 1, version: "test", pid: process.pid })
        const ready = path.join(directory.path, "ready")
        const input = command(
          directory.path,
          `printf 'hello '; while [ ! -e ${ready} ]; do sleep 0.01; done; printf world; exit 3`,
          { meta: { command: "greeting" } },
        )
        const started = yield* connection.start(input)
        expect(started.existing).toBe(false)
        expect(started.command).toMatchObject({ id: input.id, pgid: started.command.pid, deadline: null })
        expect(alive(started.command.pid)).toBe(true)

        const whole = yield* watching(connection, input.id, 0)
        const rest = yield* watching(connection, input.id, 6)
        yield* Effect.promise(() => until(() => fs.existsSync(input.output) && fs.statSync(input.output).size === 6))
        fs.writeFileSync(ready, "")
        const events = yield* Fiber.join(whole)
        expect(events[0]).toMatchObject({ type: "command", command: { id: input.id } })
        expect(text(events)).toBe("hello world")
        const exit = exitOf(events)
        expect(exit).toMatchObject({ id: input.id, status: "exited", code: 3, size: 11, lines: 0 })
        expect(exit.layout).toBeUndefined()
        expect(readExit(input.output)).toEqual(exit)
        expect(fs.readFileSync(input.output, "utf8")).toBe("hello world")
        expect(fs.statSync(input.output).mode & 0o777).toBe(0o600)

        const later = yield* Fiber.join(rest)
        expect(text(later)).toBe("world")
        expect(exitOf(later)).toEqual(exit)
      }),
    )
    await runner.closed
  })

  test("starting the same id twice gives the same command", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test" })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const input = command(directory.path, "sleep 30")
        const first = yield* connection.start(input)
        const second = yield* connection.start({ ...input, argv: ["/bin/sh", "-c", "exit 1"] })
        expect(second.existing).toBe(true)
        expect(second.command.pid).toBe(first.command.pid)
        expect((yield* connection.list).map((item) => item.id)).toEqual([input.id])
        const exit = yield* watching(connection, input.id, 0, false)
        yield* connection.signal(input.id, "SIGKILL")
        expect(exitOf(yield* Fiber.join(exit))).toMatchObject({
          status: "killed",
          signal: "SIGKILL",
        })
      }),
    )
    await runner.closed
  })

  test("a SIGTERM to a command reaches its whole group and turns into SIGKILL when ignored", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({
      directory: path.join(directory.path, "runner"),
      version: "test",
      killAfter: 200,
    })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const ready = path.join(directory.path, "ready")
        const input = command(directory.path, `trap '' TERM; sleep 30 & echo $! > child; : > ${ready}; wait; wait`)
        const started = yield* connection.start(input)
        yield* Effect.promise(() => until(() => fs.existsSync(ready)))
        const child = Number(fs.readFileSync(path.join(directory.path, "child"), "utf8"))
        expect(alive(child)).toBe(true)
        const watched = yield* watching(connection, input.id, 0, false)
        yield* connection.signal(input.id, "SIGTERM")
        const exit = exitOf(yield* Fiber.join(watched))
        expect(exit).toMatchObject({ status: "killed", signal: "SIGKILL" })
        expect(exit.ended - exit.started).toBeGreaterThanOrEqual(200)
        expect(alive(started.command.pid)).toBe(false)
        yield* Effect.promise(() => until(() => !alive(child)))
      }),
    )
    await runner.closed
  })

  test("ends a command at its deadline, which the client can move or clear", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test" })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const timed = command(directory.path, "sleep 30", { deadline: Date.now() + 60_000 })
        const cleared = command(directory.path, "sleep 0.5; printf done", { deadline: Date.now() + 100 })
        yield* connection.start(timed)
        yield* connection.start(cleared)
        const timedExit = yield* watching(connection, timed.id, 0, false)
        const clearedExit = yield* watching(connection, cleared.id)
        expect((yield* connection.deadline(cleared.id, null)).deadline).toBeNull()
        const moved = Date.now() + 100
        expect((yield* connection.deadline(timed.id, moved)).deadline).toBe(moved)
        const exit = exitOf(yield* Fiber.join(timedExit))
        expect(exit).toMatchObject({ status: "timeout", signal: "SIGTERM" })
        expect(exit.ended).toBeGreaterThanOrEqual(moved)
        const finished = yield* Fiber.join(clearedExit)
        expect(exitOf(finished)).toMatchObject({ status: "exited", code: 0 })
        expect(text(finished)).toBe("done")
      }),
    )
    await runner.closed
  })

  test("exits once no command runs: stops listening first, says bye, and frees the folder", async () => {
    await using directory = await folder()
    const folderPath = path.join(directory.path, "runner")
    const runner = await RunnerServer.serve({ directory: folderPath, version: "test" })
    const closed = await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(folderPath)
        const input = command(directory.path, "printf ok")
        yield* connection.start(input)
        const ended = yield* connection.closed
        expect(fs.existsSync(RunnerPaths.socket(folderPath))).toBe(false)
        return ended
      }),
    )
    expect(closed).toBe("bye")
    await runner.closed
    expect(fs.existsSync(RunnerPaths.token(folderPath))).toBe(false)
    expect(await run(RunnerClient.connect(folderPath).pipe(Effect.flip))).toMatchObject({ reason: "unavailable" })
    // The folder is free for the next runner.
    const next = await RunnerServer.serve({ directory: folderPath, version: "test", grace: 50 })
    await next.closed
  })

  test("a fresh runner that never gets a command exits after its grace period", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test", grace: 50 })
    await runner.closed
    expect(fs.existsSync(RunnerPaths.socket(runner.directory))).toBe(false)
  })

  test("only one runner serves a folder at a time", async () => {
    await using directory = await folder()
    const folderPath = path.join(directory.path, "runner")
    const first = await RunnerServer.serve({ directory: folderPath, version: "test", grace: 500 })
    expect(
      await RunnerServer.serve({ directory: folderPath, version: "test", wait: 100 }).catch((error) => error),
    ).toBeInstanceOf(RunnerServer.LockedError)
    await first.closed
  })

  test("refuses a client without the token and one without a shared protocol", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test", grace: 500 })
    const exchange = (line: string) =>
      new Promise<string[]>((resolve) => {
        const lines: string[] = []
        const socket = net.createConnection({ path: RunnerPaths.socket(runner.directory) })
        socket.setEncoding("utf8")
        socket.on("data", RunnerProtocol.lines((value) => lines.push(value), () => {}))
        socket.once("data", () => socket.write(line + "\n"))
        socket.on("close", () => resolve(lines))
      })
    const token = fs.readFileSync(RunnerPaths.token(runner.directory), "utf8")
    expect(fs.statSync(RunnerPaths.token(runner.directory)).mode & 0o777).toBe(0o600)
    const wrong = await exchange(JSON.stringify({ id: 0, op: "hello", protocol: 1, token: "wrong" }))
    expect(JSON.parse(wrong[0])).toMatchObject({ type: "hello", protocols: [1], version: "test" })
    expect(JSON.parse(wrong[1])).toMatchObject({ id: 0, type: "error", code: "auth" })
    const future = await exchange(JSON.stringify({ id: 0, op: "hello", protocol: 99, token }))
    expect(JSON.parse(future[1])).toMatchObject({ id: 0, type: "error", code: "protocol" })
    await runner.closed
  })

  test("reports a command that cannot start and leaves no file", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test", grace: 500 })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const input = command(directory.path, "true", { cwd: path.join(directory.path, "missing") })
        expect(yield* connection.start(input).pipe(Effect.flip)).toMatchObject({ reason: "spawn" })
        expect(fs.existsSync(input.output)).toBe(false)
      }),
    )
    await runner.closed
  })

  test("removing a command stops it and deletes its files", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test" })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const input = command(directory.path, "printf partial; sleep 30")
        yield* connection.start(input)
        const exit = yield* watching(connection, input.id, 0, false)
        yield* connection.signal(input.id, "SIGTERM", { remove: true })
        expect(exitOf(yield* Fiber.join(exit))).toMatchObject({ status: "killed" })
        expect(fs.existsSync(input.output)).toBe(false)
        expect(fs.existsSync(RunnerPaths.exit(input.output))).toBe(false)
      }),
    )
    await runner.closed
  })
})

describe("runner output", () => {
  test("keeps the first and the newest bytes within the limit, and says how much it dropped", async () => {
    await using directory = await folder()
    const bounds = { head: 16, limit: 96 }
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test", bounds })
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index).padStart(3, "0")}\n`).join("")
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const release = path.join(directory.path, "release")
        const input = command(directory.path, `printf '${lines}'; while [ ! -e ${release} ]; do sleep 0.02; done`)
        yield* connection.start(input)
        yield* Effect.promise(() => until(() => fs.existsSync(input.output) && fs.statSync(input.output).size >= 96))

        // While it runs the file holds the head and a ring of the newest bytes; reads see them in order.
        expect(fs.statSync(input.output).size).toBe(96)
        const head = yield* RunnerClient.read(runner.directory, input.id, 0, 1_000)
        expect(head).toMatchObject({ offset: 0, size: lines.length })
        expect(head.data.toString()).toBe(lines.slice(0, 16))
        const tail = yield* RunnerClient.read(runner.directory, input.id, 16, 1_000)
        expect(tail.offset).toBe(lines.length - 80)
        expect(tail.data.toString()).toBe(lines.slice(-80))

        const watched = yield* watching(connection, input.id, 0, false)
        fs.writeFileSync(release, "")
        const exit = exitOf(yield* Fiber.join(watched))
        expect(exit).toMatchObject({ status: "exited", code: 0, size: lines.length, lines: 40 })
        if (!exit.layout) throw new Error("expected a layout")
        const marker = RunnerOutput.marker(lines.length - 16 - exit.layout.kept)
        expect(exit.layout).toEqual({ head: 16, marker: marker.length, kept: 96 - 16 - marker.length })
        const file = fs.readFileSync(input.output, "utf8")
        expect(file.length).toBeLessThanOrEqual(96)
        expect(file).toBe(lines.slice(0, 16) + marker + lines.slice(-exit.layout.kept))

        // A reader of the finished file gets the head, then the marker line in place of the dropped bytes.
        const first = yield* Effect.promise(() => RunnerOutput.read(input.output, exit, 0, 1_000))
        expect(first).toMatchObject({ cursor: 16, skipped: false })
        expect(first.data.toString()).toBe(lines.slice(0, 16))
        const second = yield* Effect.promise(() => RunnerOutput.read(input.output, exit, first.cursor, 1_000))
        expect(second).toMatchObject({ cursor: lines.length, skipped: true })
        expect(second.data.toString()).toBe(marker + lines.slice(-exit.layout.kept))
        const end = yield* Effect.promise(() => RunnerOutput.read(input.output, exit, lines.length, 1_000))
        expect(end).toMatchObject({ cursor: lines.length, skipped: false })
        expect(end.data.length).toBe(0)
      }),
    )
    await runner.closed
  })

  test("a command printing about 1 GB leaves an 8 MiB file", async () => {
    await using directory = await folder()
    const runner = await RunnerServer.serve({ directory: path.join(directory.path, "runner"), version: "test" })
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(runner.directory)
        const bytes = 1_000_000_000
        const input = command(directory.path, `printf START; head -c ${bytes} /dev/zero | tr '\\0' x; printf END`)
        yield* connection.start(input)
        const exit = exitOf(yield* collect(connection, input.id, 0, false))
        expect(exit).toMatchObject({ status: "exited", code: 0, size: bytes + 8 })
        const size = fs.statSync(input.output).size
        expect(size).toBeLessThanOrEqual(RunnerOutput.LIMIT)
        expect(size).toBe(RunnerOutput.LIMIT)
        const handle = fs.openSync(input.output, "r")
        const start = Buffer.alloc(5)
        fs.readSync(handle, start, 0, 5, 0)
        const end = Buffer.alloc(3)
        fs.readSync(handle, end, 0, 3, size - 3)
        const middle = Buffer.alloc(80)
        fs.readSync(handle, middle, 0, 80, RunnerOutput.HEAD)
        fs.closeSync(handle)
        expect(start.toString()).toBe("START")
        expect(end.toString()).toBe("END")
        expect(middle.toString()).toContain(`bytes of output dropped here`)
      }),
    )
    await runner.closed
  }, 120_000)
})
