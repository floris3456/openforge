import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { WarmingPlugin } from "@opencode/core/plugin/warming"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { Document, Info } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { Money } from "@opencode/schema/money"
import { DateTime, Effect, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_warming_test")
const info = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const warming = Config.Service.of({
  entries: () =>
    Effect.succeed([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ warming: true }) })]),
  changes: () => Stream.empty,
})
const finished = (): SessionEvent.Execution.Succeeded => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.execution.succeeded",
  data: { sessionID },
})

/** Runs the warming plugin with `warming: true`; `turn` is one step on the given provider, then its end. */
const run = Effect.fnUntraced(function* () {
  let context: ((input: SessionContext) => Effect.Effect<void>) | undefined
  const keepAlives = new Array<string>()
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
        generate: (input) =>
          Effect.sync(() => {
            keepAlives.push(input.prompt)
            return { text: "OK" }
          }),
      },
    }),
  ).pipe(Effect.provideService(Config.Service, warming))
  const hook = context
  if (!hook) return yield* Effect.die("the warming plugin registered no context hook")
  const turn = (providerID: string) =>
    Effect.gen(function* () {
      yield* hook({
        sessionID,
        agent: Agent.defaultID,
        model: { id: Model.ID.make("claude-test-1"), providerID: Provider.ID.make(providerID) },
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
  return { turn, wait, keepAlives }
})

describe("WarmingPlugin", () => {
  it.effect("keeps a chat on another provider warm", () =>
    Effect.gen(function* () {
      const warm = yield* run()
      yield* warm.turn("anthropic")
      yield* warm.wait(4)
      expect(warm.keepAlives).toHaveLength(1)
    }),
  )

  it.effect("sends no keep-alive for a chat on CLIProxyPacer, which pings its chats itself", () =>
    Effect.gen(function* () {
      const warm = yield* run()
      yield* warm.turn(PacerEndpoint.id)
      yield* warm.wait(31)
      expect(warm.keepAlives).toEqual([])
    }),
  )

  it.effect("stops warming a chat once it moves to CLIProxyPacer", () =>
    Effect.gen(function* () {
      const warm = yield* run()
      yield* warm.turn("anthropic")
      yield* warm.wait(1)
      yield* warm.turn(PacerEndpoint.id)
      yield* warm.wait(31)
      expect(warm.keepAlives).toEqual([])
    }),
  )
})
