import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ContinuityCommand } from "@opencode/core/continuity/command"
import { KV } from "@opencode/core/kv"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(KV.node))

/** A command that counts its runs. */
const counted = () => {
  const command = {
    runs: 0,
    run: Effect.sync(() => {
      command.runs++
    }),
  }
  return command
}

// A slash command a client sends again with its id, as after a connection that dropped while a release switch stopped
// the service: the service that gets it again does not run it again.
describe("ContinuityCommand.once", () => {
  it.effect("runs a command given an id once, and one without an id every time", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const command = counted()
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_review"))
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_review"))
      expect(command.runs).toBe(1)
      yield* command.run.pipe(ContinuityCommand.once(kv, undefined))
      yield* command.run.pipe(ContinuityCommand.once(kv, undefined))
      expect(command.runs).toBe(3)
    }),
  )

  it.effect("does not run a command again that is sent again while it runs", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const release = yield* Deferred.make<void>()
      let runs = 0
      const run = Effect.suspend(() => (++runs === 1 ? Deferred.await(release) : Effect.void))
      const first = yield* run.pipe(
        ContinuityCommand.once(kv, "msg_slow"),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* run.pipe(ContinuityCommand.once(kv, "msg_slow"))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(runs).toBe(1)
    }),
  )

  it.effect("does not run a command again that a stop cut off", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      let runs = 0
      const run = Effect.suspend(() => (++runs === 1 ? Effect.never : Effect.void))
      const first = yield* run.pipe(ContinuityCommand.once(kv, "msg_cut"), Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(first)
      yield* run.pipe(ContinuityCommand.once(kv, "msg_cut"))
      expect(runs).toBe(1)
    }),
  )

  it.effect("runs a command that failed again", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      let runs = 0
      const failing = Effect.suspend(() => {
        runs++
        return Effect.fail("plugin failed")
      })
      expect(yield* failing.pipe(ContinuityCommand.once(kv, "msg_failed"), Effect.flip)).toBe("plugin failed")
      expect(yield* failing.pipe(ContinuityCommand.once(kv, "msg_failed"), Effect.flip)).toBe("plugin failed")
      expect(runs).toBe(2)
    }),
  )

  it.effect("forgets an id after 10 minutes, longer than a client resends", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const command = counted()
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_old"))
      yield* TestClock.adjust("9 minutes")
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_old"))
      expect(command.runs).toBe(1)
      yield* TestClock.adjust("2 minutes")
      // The next command clears the ids older than that.
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_new"))
      expect(yield* kv.get("session.command/msg_old")).toBeUndefined()
      expect(yield* kv.get("session.command/msg_new")).toBeDefined()
      yield* command.run.pipe(ContinuityCommand.once(kv, "msg_old"))
      expect(command.runs).toBe(3)
    }),
  )
})
