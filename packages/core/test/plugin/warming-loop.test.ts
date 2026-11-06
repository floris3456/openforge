import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { WarmingPlugin } from "@opencode/core/plugin/warming"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { Document, Info } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { Money } from "@opencode/schema/money"
import { Clock, DateTime, Effect, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_warming_loop_test")
const info = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const finished = (): SessionEvent.Execution.Succeeded => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.execution.succeeded",
  data: { sessionID },
})

describe("WarmingPlugin's loop", () => {
  it.effect("ends once warming is turned off and on again, so one loop warms the chat", () =>
    Effect.gen(function* () {
      let enabled = true
      const config = Config.Service.of({
        entries: () =>
          Effect.sync(() => [
            new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ warming: enabled }) }),
          ]),
        changes: () => Stream.empty,
      })
      // The time each keep-alive starts at. One takes a while, as a model request does.
      const sent = new Array<number>()
      let context: ((input: SessionContext) => Effect.Effect<void>) | undefined
      const events = yield* Queue.unbounded<SessionEvent.Execution.Succeeded>()
      yield* WarmingPlugin.Plugin.effect(
        host({
          event: { subscribe: () => Stream.fromQueue(events) },
          session: {
            hook: (name, callback) => {
              if (name === "context") context = callback as (input: SessionContext) => Effect.Effect<void>
              return Effect.succeed({ dispose: Effect.void })
            },
            get: () => Effect.succeed(info),
            generate: () =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) => Effect.sync(() => sent.push(now))),
                Effect.andThen(Effect.sleep("10 seconds")),
                Effect.as({ text: "OK" }),
              ),
          },
        }),
      ).pipe(Effect.provideService(Config.Service, config))
      const hook = context
      if (!hook) return yield* Effect.die("the warming plugin registered no context hook")
      const turn = Effect.gen(function* () {
        yield* hook({
          sessionID,
          agent: Agent.defaultID,
          model: { id: Model.ID.make("claude-test-1"), providerID: Provider.ID.make("anthropic") },
          system: [],
          messages: [Message.user("Hello")],
          tools: {},
          options: {},
        })
        yield* Queue.offer(events, finished())
        yield* Effect.yieldNow
      })
      const wait = (minutes: number) =>
        TestClock.adjust(`${minutes} minutes`).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow))

      yield* turn // minute 0: warmed from here, its loop's first keep-alive due at minute 4
      yield* wait(1)
      enabled = false
      yield* turn // minute 1: warming is off, and the chat's entry is deleted
      yield* wait(1)
      enabled = true
      yield* turn // minute 2: on again, a new entry with its own loop, due at minute 6
      yield* wait(9)

      // One keep-alive at minute 6, the next 4 minutes after it ended (6:10), at 10:10.
      expect(sent).toEqual([6 * 60_000, 610_000])
    }),
  )
})
