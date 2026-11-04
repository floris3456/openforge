import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { KV } from "@opencode/core/kv"
import { SessionCommand } from "@opencode/core/session/command"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(KV.node))

// A slash command a client sends again with its id, as after a connection that dropped while a release switch stopped
// the service: the service that gets it again does not run it again.
describe("SessionCommand.once", () => {
  it.effect("runs a command given an id once, and one without an id every time", () =>
    Effect.gen(function* () {
      let runs = 0
      const run = Effect.sync(() => {
        runs++
      })
      yield* SessionCommand.once("msg_review", run)
      yield* SessionCommand.once("msg_review", run)
      expect(runs).toBe(1)
      yield* SessionCommand.once(undefined, run)
      yield* SessionCommand.once(undefined, run)
      expect(runs).toBe(3)
    }),
  )

  it.effect("runs a command that failed again", () =>
    Effect.gen(function* () {
      let runs = 0
      const failing = Effect.suspend(() => {
        runs++
        return Effect.fail("plugin failed")
      })
      expect(yield* SessionCommand.once("msg_failed", failing).pipe(Effect.flip)).toBe("plugin failed")
      expect(yield* SessionCommand.once("msg_failed", failing).pipe(Effect.flip)).toBe("plugin failed")
      expect(runs).toBe(2)
    }),
  )

  it.effect("forgets an id after 10 minutes, longer than a client resends", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      let runs = 0
      const run = Effect.sync(() => {
        runs++
      })
      yield* SessionCommand.once("msg_old", run)
      yield* TestClock.adjust("9 minutes")
      yield* SessionCommand.once("msg_old", run)
      expect(runs).toBe(1)
      yield* TestClock.adjust("2 minutes")
      // The next command clears the ids older than that.
      yield* SessionCommand.once("msg_new", run)
      expect(yield* kv.get("session.command/msg_old")).toBeUndefined()
      expect(yield* kv.get("session.command/msg_new")).toBeDefined()
      yield* SessionCommand.once("msg_old", run)
      expect(runs).toBe(3)
    }),
  )
})
