import { describe, expect } from "bun:test"
import fs from "fs"
import net from "net"
import path from "path"
import { Effect, Fiber, Queue, Schedule, Stream } from "effect"
import { RunnerClient } from "@opencode/runner/client"
import { RunnerPaths } from "@opencode/runner/paths"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { ShellRunner } from "@opencode/core/shell/runner"
import { Workspace } from "@opencode/core/workspace"
import type { Shell as ShellSchema } from "@opencode/schema/shell"
import { alive, machine } from "./fixture/runner"
import { it } from "./lib/effect"

const gated = (release: string, before: string, after: string) =>
  `printf %s ${before}; while [ ! -e ${release} ]; do sleep 0.02; done; printf %s ${after}`

const until = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  )

// Takes watch events until the output so far reads `text` (or the command has exited); returns that output.
const read = (events: Queue.Queue<ShellSchema.WatchEvent>, text: string) =>
  Effect.gen(function* () {
    let output = ""
    while (output !== text) {
      const event = yield* Queue.take(events)
      if (event.type === "exited") break
      output += event.output
    }
    return output
  }).pipe(Effect.timeout("10 seconds"))

describe("Shell through the tool runner", () => {
  for (const workspace of [false, true])
    it.live(
      `watch pushes output as it arrives, then the exit${workspace ? ", also in a workspace's own environment" : ""}`,
      () =>
        Effect.gen(function* () {
          const host = yield* machine
          const release = path.join(host.tmp, "release")
          const location = workspace
            ? Location.Ref.make({ directory: host.ref.directory, workspaceID: Workspace.ID.make("wrk_watch") })
            : undefined
          yield* Effect.gen(function* () {
            const shell = yield* Shell.Service
            const info = yield* shell.create({ shell: "/bin/sh", command: gated(release, "one", "two"), timeout: 0 })
            const events = yield* Queue.unbounded<ShellSchema.WatchEvent>()
            yield* shell.watch(info.id).pipe(
              Stream.runForEach((event) => Queue.offer(events, event)),
              Effect.forkScoped({ startImmediately: true }),
            )
            // Pushed while the command still waits for its release.
            expect(yield* read(events, "one")).toBe("one")
            expect((yield* shell.get(info.id)).status).toBe("running")
            fs.writeFileSync(release, "")
            expect(yield* read(events, "two")).toBe("two")
            expect(yield* Queue.take(events)).toMatchObject({ type: "exited", info: { status: "exited", exit: 0 } })

            // A later watch of the finished command gets all of it from its file, from a cursor on.
            const again = yield* shell.watch(info.id, { cursor: 1 }).pipe(Stream.runCollect)
            expect(again.map((event) => (event.type === "output" ? event.output : event.type))).toEqual([
              "netwo",
              "exited",
            ])
          }).pipe(Effect.scoped, Effect.provide(host.service({ location })))
        }),
    )

  it.live("reports a runner it can't reach, and neither a folder with no runner nor one it reaches", () =>
    Effect.gen(function* () {
      const host = yield* machine
      const release = path.join(host.tmp, "release")
      // A runner that holds a command, which the next service reaches.
      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        yield* shell.create({ shell: "/bin/sh", command: gated(release, "a", "b"), timeout: 0 })
        yield* (yield* ShellRunner.Service).detach
      }).pipe(Effect.scoped, Effect.provide(host.service({ version: "0.1.0" })))
      // A folder left behind, with no runner in it.
      fs.mkdirSync(RunnerPaths.directory(host.state, "0.0.9"), { recursive: true })
      // Something answering in a runner's place that doesn't speak its protocol.
      const foreign = RunnerPaths.directory(host.state, "9.0.0")
      fs.mkdirSync(foreign, { recursive: true })
      fs.writeFileSync(RunnerPaths.token(foreign), "token")
      const server = net.createServer((socket) => socket.end("not a runner\n"))
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(RunnerPaths.socket(foreign), () => resume(Effect.void))
        }),
        () => Effect.sync(() => server.close()),
      )

      const runners = yield* Effect.gen(function* () {
        return yield* (yield* ShellRunner.Service).runners
      }).pipe(Effect.scoped, Effect.provide(host.service({ version: "0.1.1" })))
      expect(runners.toSorted((a, b) => a.version.localeCompare(b.version))).toEqual([
        { version: "0.1.0", reachable: true },
        { version: "9.0.0", reachable: false, reason: "the runner did not greet" },
      ])
      fs.writeFileSync(release, "")
    }),
  )

  it.live("a service shutdown leaves its commands running, and the next service picks them up", () =>
    Effect.gen(function* () {
      const host = yield* machine
      const release = path.join(host.tmp, "release")
      const started = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const runner = yield* ShellRunner.Service
        const info = yield* shell.create({
          shell: "/bin/sh",
          command: gated(release, "before", "after"),
          timeout: 60_000,
        })
        // Waiting as the shell tool does: an interrupted wait removes the command, unless the service is stopping.
        yield* shell.result(info).pipe(
          Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* runner.detach
        return info
      }).pipe(Effect.scoped, Effect.provide(host.service()))
      if (started.pid === undefined) throw new Error("expected a pid")
      expect(alive(started.pid)).toBe(true)

      const result = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        expect(yield* shell.get(started.id)).toMatchObject({
          status: "running",
          pid: started.pid,
          command: started.command,
          file: started.file,
          time: { started: started.time.started },
        })
        expect((yield* shell.list()).map((info) => info.id)).toEqual([started.id])
        yield* until(() => fs.existsSync(started.file) && fs.readFileSync(started.file, "utf8") === "before")
        expect((yield* shell.output(started.id)).output).toBe("before")
        fs.writeFileSync(release, "")
        return yield* shell.result(started)
      }).pipe(Effect.scoped, Effect.provide(host.service()))
      expect(result).toMatchObject({
        info: { status: "exited", exit: 0, time: { completed: expect.any(Number) } },
        capture: { output: "beforeafter", truncated: false },
      })
    }),
  )

  it.live("a user interrupt still ends the command", () =>
    Effect.gen(function* () {
      const host = yield* machine
      const info = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const info = yield* shell.create({ shell: "/bin/sh", command: "sleep 30", timeout: 0 })
        const waiting = yield* shell.result(info).pipe(
          Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Fiber.interrupt(waiting)
        return info
      }).pipe(Effect.scoped, Effect.provide(host.service()))
      if (info.pid === undefined) throw new Error("expected a pid")
      yield* until(() => !alive(info.pid ?? 0))
      expect(fs.existsSync(info.file)).toBe(false)
    }),
  )

  it.live("a finished command is known from its exit file once its runner is gone", () =>
    Effect.gen(function* () {
      const host = yield* machine
      const finished = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const info = yield* shell.create({ shell: "/bin/sh", command: "printf done; exit 4", timeout: 0 })
        return yield* shell.wait(info.id)
      }).pipe(Effect.scoped, Effect.provide(host.service()))
      yield* Effect.promise(() => Promise.all(host.runners.map((runner) => runner.closed)))
      expect(fs.existsSync(RunnerPaths.socket(RunnerPaths.directory(host.state, "test")))).toBe(false)

      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        expect(yield* shell.get(finished.id)).toEqual(finished)
        expect(yield* shell.wait(finished.id)).toEqual(finished)
        expect(yield* shell.output(finished.id)).toEqual({ output: "done", cursor: 4, size: 4, truncated: false })
        expect((yield* shell.result(finished)).capture).toEqual({ output: "done", truncated: false })
        expect(yield* shell.list()).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(host.service()))
    }),
  )

  it.live("a newer release runs new commands in its own runner and finishes the older runner's commands", () =>
    Effect.gen(function* () {
      const host = yield* machine
      const release = path.join(host.tmp, "release")
      const old = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const info = yield* shell.create({ shell: "/bin/sh", command: gated(release, "old", "-done"), timeout: 0 })
        yield* (yield* ShellRunner.Service).detach
        return info
      }).pipe(Effect.scoped, Effect.provide(host.service({ version: "0.1.0" })))

      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const fresh = yield* shell.create({ shell: "/bin/sh", command: "sleep 30", timeout: 0 })
        expect(host.runners.map((runner) => path.basename(runner.directory))).toEqual(["0.1.0", "0.1.1"])
        expect((yield* shell.list()).map((info) => info.id).toSorted()).toEqual([old.id, fresh.id].toSorted())
        fs.writeFileSync(release, "")
        expect(yield* shell.wait(old.id)).toMatchObject({ status: "exited", exit: 0 })
        expect((yield* shell.output(old.id)).output).toBe("old-done")
        // The old runner exits after its last command; the new one keeps running.
        yield* Effect.promise(() => host.runners[0].closed)
        expect((yield* shell.get(fresh.id)).status).toBe("running")
        yield* shell.remove(fresh.id)
      }).pipe(Effect.scoped, Effect.provide(host.service({ version: "0.1.1" })))
    }),
  )

  it.live(
    "when the runner dies, its running commands are stopped and fail as 'the tool runner stopped unexpectedly'",
    () =>
      Effect.gen(function* () {
        const host = yield* machine
        yield* Effect.gen(function* () {
          const shell = yield* Shell.Service
          const ready = path.join(host.tmp, "ready")
          const info = yield* shell.create({
            shell: "/bin/sh",
            command: `sleep 30 & echo $! > child; : > ${ready}; wait`,
            cwd: host.tmp,
            timeout: 0,
          })
          yield* until(() => fs.existsSync(ready))
          const child = Number(fs.readFileSync(path.join(host.tmp, "child"), "utf8"))
          const waiting = yield* shell.wait(info.id).pipe(Effect.flip, Effect.forkScoped)
          const runner = yield* RunnerClient.connect(RunnerPaths.directory(host.state, "test")).pipe(Effect.scoped)
          expect(runner.pid).not.toBe(process.pid)
          process.kill(runner.pid, "SIGKILL")

          const error = yield* Fiber.join(waiting)
          expect(error).toBeInstanceOf(Shell.RunnerStoppedError)
          expect(error.message).toBe("the tool runner stopped unexpectedly")
          yield* until(() => !alive(info.pid ?? 0) && !alive(child))
          expect(yield* shell.get(info.id)).toMatchObject({ status: "killed" })
          expect(JSON.parse(fs.readFileSync(RunnerPaths.exit(info.file), "utf8"))).toMatchObject({
            status: "failed",
            error: "the tool runner stopped unexpectedly",
          })
          expect(yield* shell.result(info).pipe(Effect.flip)).toBeInstanceOf(Shell.RunnerStoppedError)
        }).pipe(Effect.scoped, Effect.provide(host.service({ separate: true })))
      }),
    { timeout: 20_000 },
  )
})
