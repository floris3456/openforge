import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Pacer } from "@opencode/schema/pacer"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { PacerAttention } from "@opencode/core/pacer/attention"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { testEffect } from "../lib/effect"

// What needs attention on CLIProxyPacer, told once per new thing (the workspace's spec attention-notifications), over
// the real bus and KV store. The connection's read of the list is tested in connection.test.ts. The clock is
// TestClock's.

const it = testEffect(Layer.empty)

const MIN = 60_000
const BASE = "https://cpp.example/management.html"

const item = (id: string, fields: Partial<PacerAttention.Item> = {}): PacerAttention.Item => ({
  id,
  tone: "bad",
  what: `${id} needs you`,
  fix: "Accounts",
  page: "providers",
  params: { f: `provider:${id}` },
  ...fields,
})

const setup = Effect.fnUntraced(function* () {
  const context = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, KV.node])))
  const bus = Context.get(context, Bus.Service)
  const kv = Context.get(context, KV.Service)
  const raised: Pacer.AttentionRaised[] = []
  yield* bus.subscribe([Pacer.Event.AttentionRaised]).pipe(
    Stream.runForEach((event) => Effect.sync(() => void raised.push(event.data))),
    Effect.forkScoped({ startImmediately: true }),
  )
  /** A service as it starts: a new one over the same KV store is a restart. */
  const start = () =>
    PacerAttention.make.pipe(Effect.provideService(Bus.Service, bus), Effect.provideService(KV.Service, kv))
  const endpoint = PacerEndpoint.resolve({ baseURL: "https://cpp.example/v1", apiKey: "key-one" }, undefined)!
  return { start, raised, endpoint }
})

type Setup = Effect.Success<ReturnType<typeof setup>>

/** Reads `items` as the connection does, past the claim's wait. */
const read = Effect.fnUntraced(function* (
  h: Setup,
  service: PacerAttention.Interface,
  items: ReadonlyArray<PacerAttention.Item>,
) {
  const fiber = yield* service.read(h.endpoint, items, BASE).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  yield* TestClock.adjust(PacerAttention.CLAIM_MS)
  yield* Fiber.join(fiber)
})

const told = (h: Setup) => h.raised.map((r) => r.items.map((i) => i.id).join("+"))

describe("PacerAttention", () => {
  it.effect("the list as it is at the first read tells nothing; what appears after is told once", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const service = yield* h.start()
      yield* read(h, service, [item("a")])
      expect(told(h)).toEqual([])
      yield* read(h, service, [item("a"), item("b")])
      yield* read(h, service, [item("a"), item("b")])
      expect(told(h)).toEqual(["b"])
      expect(h.raised[0]).toMatchObject({
        title: "CLIProxyPacer",
        message: "b needs you",
        link: `${BASE}#/providers?f=provider%3Ab`,
      })
    }),
  )

  it.effect("an item comes again as new only after it was gone 30 minutes", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const service = yield* h.start()
      yield* read(h, service, [])
      yield* read(h, service, [item("flap")])
      expect(told(h)).toEqual(["flap"])
      // Gone, back within 30 minutes: not again.
      yield* read(h, service, [])
      yield* TestClock.adjust(29 * MIN)
      yield* read(h, service, [item("flap")])
      expect(told(h)).toEqual(["flap"])
      // Gone 30 minutes: again.
      yield* read(h, service, [])
      yield* TestClock.adjust(PacerAttention.GONE_MS)
      yield* read(h, service, [item("flap")])
      expect(told(h)).toEqual(["flap", "flap"])
    }),
  )

  it.effect("several new at once are one notification", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const service = yield* h.start()
      yield* read(h, service, [])
      yield* read(h, service, [item("a", { detail: "since 5m" }), item("b"), item("c")])
      expect(told(h)).toEqual(["a+b+c"])
      expect(h.raised[0].message).toBe("3 things need attention: a needs you; b needs you; c needs you")
    }),
  )

  it.effect("a new member of a grouped item is told although the item was there", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const service = yield* h.start()
      const usedup = (...members: string[]) =>
        item("usedup", { tone: "warn", members: members.map((id) => ({ id, what: id })) })
      yield* read(h, service, [usedup("ann")])
      yield* read(h, service, [usedup("ann")])
      expect(told(h)).toEqual([])
      yield* read(h, service, [usedup("ann", "bob")])
      expect(told(h)).toEqual(["usedup"])
      // The line names the new member: the item itself was told before.
      expect(h.raised[0].message).toBe("usedup needs you: bob is new")
    }),
  )

  it.effect("a restart tells only what appeared meanwhile; what was told stays told", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const before = yield* h.start()
      yield* read(h, before, [])
      yield* read(h, before, [item("a")])
      expect(told(h)).toEqual(["a"])
      const after = yield* h.start()
      yield* read(h, after, [item("a"), item("b")])
      expect(told(h)).toEqual(["a", "b"])
    }),
  )

  it.effect("the first TUI to claim a batch has it; one no TUI claimed goes to the players", () =>
    Effect.gen(function* () {
      const h = yield* setup()
      const service = yield* h.start()
      const delivered: string[] = []
      yield* service.unclaimed((raised) => Effect.sync(() => void delivered.push(raised.batch)))
      yield* read(h, service, [])
      const fiber = yield* service.read(h.endpoint, [item("a")], BASE).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const batch = h.raised[0].batch
      expect(yield* service.claim(batch)).toBe(true)
      expect(yield* service.claim(batch)).toBe(false)
      yield* TestClock.adjust(PacerAttention.CLAIM_MS)
      yield* Fiber.join(fiber)
      expect(delivered).toEqual([])
      yield* read(h, service, [item("a"), item("b")])
      expect(delivered).toEqual([h.raised[1].batch])
      expect(yield* service.claim(h.raised[1].batch)).toBe(false)
    }),
  )
})
