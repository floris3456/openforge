export * as PacerAttention from "./attention.js"

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Pacer } from "@opencode/schema/pacer"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"
import type { PacerEndpoint } from "./endpoint.js"

// What needs the owner's attention on CLIProxyPacer (the workspace's spec attention-notifications): CPP computes the
// list its dashboard shows and serves it to a key the owner allows (`GET /pacer/v1/attention`), and tells the key's
// change stream when it changes; the connection reads it then (`PacerConnection`) and hands it here. Each new thing
// is told once, as `pacer.attention.raised`, which every TUI raises as a notification of its own kind (several new at
// once are one), and the first TUI to claim it raises it. A thing is an item, or a member of a grouped item (each
// newly used-up account, each model without a price). It is told when it appears, not again while it lasts, and again
// only after it has been gone for GONE_MS. What was seen is kept in the KV store per CPP and key, so a restart tells
// only what appeared meanwhile; with nothing kept (the first list from this CPP and key) nothing is told.

/** A thing gone this long is new again when it comes back. */
export const GONE_MS = 30 * 60_000
/** How long the TUIs have to claim a batch before the service delivers it to the players itself. */
export const CLAIM_MS = 2_000
/** Batches whose claim is kept. */
const CLAIMS = 20
const TITLE = "CLIProxyPacer"
/** Its sound by default, in the TUI's settings and when the service delivers it. */
export const SOUND = "alert-01"

/** An item of CPP's list, as `GET /pacer/v1/attention` answers it. */
export const Item = Schema.Struct({
  id: Schema.String,
  tone: Schema.Literals(["bad", "warn", "info"]),
  what: Schema.String,
  detail: Schema.optional(Schema.String),
  fix: Schema.String,
  page: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  members: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, what: Schema.String }))),
})
export type Item = typeof Item.Type
export const List = Schema.Struct({ items: Schema.Array(Item) })

/** What was seen, by thing: absent `gone` while it lasts, else when it went (ms). */
export type Seen = Record<string, { readonly gone?: number }>

export interface Interface {
  /**
   * CPP's list as just read from `endpoint`: tells what is new, once, and waits CLAIM_MS for a TUI to claim it; none
   * did, it hands it to {@link Interface.unclaimed}'s deliverers.
   */
  readonly read: (endpoint: PacerEndpoint.Endpoint, items: ReadonlyArray<Item>, base: string) => Effect.Effect<void>
  /** The first claim of a batch wins: true once, false after (and for a batch it doesn't know). */
  readonly claim: (batch: string) => Effect.Effect<boolean>
  /** Adds a deliverer of the batches no TUI claimed: the service's players. */
  readonly unclaimed: (deliver: (raised: Pacer.AttentionRaised) => Effect.Effect<void>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerAttention") {}

export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const kv = yield* KV.Service
  const claims = new Map<string, boolean>()
  const deliverers = new Set<(raised: Pacer.AttentionRaised) => Effect.Effect<void>>()
  let batches = 0

  const claim = (batch: string) =>
    Effect.sync(() => {
      if (claims.get(batch) !== false) return false
      claims.set(batch, true)
      return true
    })

  return Service.of({
    read: (endpoint, items, base) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const key = `pacer.attention:${endpoint.origin}:${fingerprint(endpoint.key)}`
        const kept = yield* kv.get(key)
        const next = decide(Schema.is(SeenSchema)(kept) ? kept : undefined, things(items), now)
        yield* kv.set(key, next.seen)
        const fresh = items.filter((item) => next.fresh.has(item.id))
        if (fresh.length === 0) return
        const batch = `${now}-${++batches}`
        claims.set(batch, false)
        for (const old of claims.keys()) if (claims.size > CLAIMS) claims.delete(old)
        const raised = raise(batch, fresh, base)
        yield* bus.publish(Pacer.Event.AttentionRaised, raised)
        yield* Effect.sleep(CLAIM_MS)
        if (!(yield* claim(batch))) return
        for (const deliver of deliverers) yield* deliver(raised)
      }),
    claim,
    unclaimed: (deliver) => Effect.sync(() => void deliverers.add(deliver)),
  })
})

const SeenSchema = Schema.Record(Schema.String, Schema.Struct({ gone: Schema.optional(Schema.Finite) }))

/** The things of a list: each member of a grouped item, else the item; with the item each belongs to. */
export function things(items: ReadonlyArray<Item>) {
  return items.flatMap((item) =>
    item.members && item.members.length > 0
      ? item.members.map((member) => ({ id: member.id, item: item.id }))
      : [{ id: item.id, item: item.id }],
  )
}

/**
 * The rules: what is seen now, and the items with a thing that is new. Without anything kept, everything is seen and
 * nothing new. A thing is new when nothing of it is kept, or it went GONE_MS ago or longer; one that went is kept with
 * when it went, and forgotten GONE_MS after.
 */
export function decide(kept: Seen | undefined, now: ReadonlyArray<{ id: string; item: string }>, at: number) {
  const seen: Record<string, { gone?: number }> = {}
  const fresh = new Set<string>()
  for (const thing of now) {
    const entry = kept?.[thing.id]
    if (kept && (!entry || (entry.gone !== undefined && at - entry.gone >= GONE_MS))) fresh.add(thing.item)
    seen[thing.id] = {}
  }
  for (const [id, entry] of Object.entries(kept ?? {})) {
    if (id in seen) continue
    const gone = entry.gone ?? at
    if (at - gone < GONE_MS) seen[id] = { gone }
  }
  return { seen, fresh }
}

/** One notification for the new items: one says what it is, several how many and what. */
export function raise(batch: string, items: ReadonlyArray<Item>, base: string): Pacer.AttentionRaised {
  const first = items[0]
  const text = (item: Item) => (item.detail ? `${item.what} — ${item.detail}` : item.what)
  const query = new URLSearchParams(first.params ?? {}).toString()
  return {
    batch,
    title: TITLE,
    message: (items.length === 1
      ? text(first)
      : `${items.length} things need attention: ${items.map((item) => item.what).join("; ")}`
    ).slice(0, 1000),
    link: `${base}#/${first.page}${query ? `?${query}` : ""}`,
    items: items.map((item) => ({ id: item.id, tone: item.tone, what: item.what })),
  }
}

/** A short fingerprint of the key, so a kept list is the key's without the key in it. */
function fingerprint(key: string) {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16)
}

export const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node, KV.node] })
