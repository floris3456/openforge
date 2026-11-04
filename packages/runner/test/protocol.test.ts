import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Stream } from "effect"
import { RunnerClient } from "../src/client.js"
import { RunnerProtocol } from "../src/protocol.js"
import { folder, run } from "./fixture/runner.js"
import { serveV1 } from "./fixture/runner-v1.js"

describe("runner protocol", () => {
  test("this release's client speaks protocol 1, as the runner of 0.1.0 does", async () => {
    await using directory = await folder()
    const runner = await serveV1(path.join(directory.path, "runner"))
    await run(
      Effect.gen(function* () {
        const connection = yield* RunnerClient.connect(path.join(directory.path, "runner"))
        expect(connection).toMatchObject({ protocol: 1, version: "0.1.0", pid: 4242 })
        const started = yield* connection.start({
          id: "sh_0123456789abFIXTURE00000",
          argv: ["/bin/sh", "-c", "printf 'hello world'"],
          cwd: directory.path,
          env: {},
          deadline: 1_700_000_100_000,
          output: path.join(directory.path, "runner", "sh_0123456789abFIXTURE00000.out"),
          meta: {},
        })
        expect(started).toMatchObject({ existing: false, command: { pgid: 4242, deadline: 1_700_000_100_000 } })
        expect((yield* connection.deadline(started.command.id, null)).deadline).toBeNull()
        expect((yield* connection.list).map((command) => command.id)).toEqual([started.command.id])
        const events = yield* connection.watch(started.command.id, { offset: 0, output: true }).pipe(Stream.runCollect)
        expect(events.map((event) => event.type)).toEqual(["command", "output", "output", "exit"])
        expect(Buffer.concat(events.flatMap((event) => (event.type === "output" ? [event.data] : []))).toString()).toBe(
          "hello world",
        )
        expect(events.at(-1)).toMatchObject({ type: "exit", exit: { status: "exited", code: 0, size: 11 } })
        yield* connection.signal(started.command.id, "SIGTERM", { remove: true })
      }),
    )
    expect(runner.requests.map((request) => (request as { op: string }).op)).toEqual([
      "hello",
      "start",
      "deadline",
      "list",
      "watch",
      "signal",
    ])
    expect(runner.requests[0]).toEqual({ id: 1, op: "hello", protocol: 1, token: "v1-token" })
    expect(runner.requests[5]).toEqual({
      id: 6,
      op: "signal",
      command: "sh_0123456789abFIXTURE00000",
      signal: "SIGTERM",
      remove: true,
    })
    await runner.close()
  })

  test("picks the newest version both sides speak", async () => {
    await using directory = await folder()
    const runner = await serveV1(path.join(directory.path, "runner"), [1, 2])
    const connection = await run(RunnerClient.connect(path.join(directory.path, "runner")))
    expect(connection.protocol).toBe(Math.max(...RunnerProtocol.SUPPORTED.filter((version: number) => version <= 2)))
    await runner.close()
  })

  test("refuses a runner that speaks no version this release knows", async () => {
    await using directory = await folder()
    const runner = await serveV1(path.join(directory.path, "runner"), [99])
    const error = await run(RunnerClient.connect(path.join(directory.path, "runner")).pipe(Effect.flip))
    expect(error).toMatchObject({ reason: "protocol" })
    expect(error.message).toContain("speaks protocol 99")
    await runner.close()
  })
})
