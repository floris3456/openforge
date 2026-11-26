export * as PacerBadges from "./badges.js"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, Scope, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { Bus } from "../bus.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"
import { PacerSessionID } from "./session-id.js"
import { PacerWire } from "./wire.js"

// Agents' colours in the terminal (the workspace's spec `docs/specs/agent-badges.md`, section 3, item 3): CPP gives each
// chat's identity's badge with the chat, `agent_badge` beside `agent_identity` on its session view and on each chat its
// list names. The TUI shows a chat's title in its badge scheme's colour, and the agent theme takes the root chat's hue.
// This keeps the badge of each chat CPP named, learnt from the views and lists the connection reads anyway; a chat the
// TUI asks about that nothing named is read from its own session view, once. A scheme never changes, so a badge is kept
// until CPP names another for the chat (a link to another identity) or a link here forgets it. All of it only while
// CPP's capabilities say `memory.badges`: without them nothing is read, given or told.

/** Chats whose badge is kept, and chats a TUI asked about; past it the oldest goes. */
export const KEPT = 2_000
/** Views read at once for chats nothing named. */
export const READS = 2

export interface Interface {
  /** Learns the badge a view or list item names for chat `uuid` (`X-Pacer-Session`); one that names none changes nothing. */
  readonly learn: (uuid: string, item: { readonly agent_badge?: unknown }) => Effect.Effect<void>
  /**
   * The badges known of `sessionIDs`; each other one is read from its view and told as `pacer.badge.updated` once
   * known. Nothing without `memory.badges`.
   */
  readonly get: (sessionIDs: ReadonlyArray<SessionID>) => Effect.Effect<Pacer.Badges>
  /** Forgets the chat's badge and reads it again: its identity changed. */
  readonly forget: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerBadges") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const models = yield* PacerModels.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    const reads = yield* Semaphore.make(READS)

    const offered = Effect.map(models.get(), (catalog) => catalog?.pacer?.memory?.badges === true)
    /** By CPP's UUID of the chat: its badge, `null` for none. */
    const badges = new Map<string, Pacer.Badge | null>()
    /** The chats a TUI asked about, by CPP's UUID: only their badges are told. */
    const asked = new Map<string, SessionID>()
    const reading = new Set<string>()

    const keep = <V>(map: Map<string, V>, key: string, value: V) => {
      map.delete(key)
      map.set(key, value)
      if (map.size > KEPT) map.delete(map.keys().next().value!)
    }

    const set = Effect.fnUntraced(function* (uuid: string, badge: Pacer.Badge | null) {
      const was = badges.get(uuid)
      keep(badges, uuid, badge)
      const sessionID = asked.get(uuid)
      if (sessionID === undefined || (was !== undefined && isDeepStrictEqual(was, badge))) return
      if (yield* offered) yield* bus.publish(Pacer.Event.BadgeUpdated, { sessionID, badge })
    })

    /** Reads the chat's view for its badge, in the background; CPP knowing no such chat means it has none. */
    const read = (uuid: string) => {
      if (reading.has(uuid)) return Effect.void
      reading.add(uuid)
      return http.get(`/pacer/v1/sessions/${encodeURIComponent(uuid)}`, PacerWire.View, { failover: true }).pipe(
        Effect.flatMap((answer) => set(uuid, PacerWire.badge(answer.body) ?? null)),
        Effect.catchTag("PacerHttp.NotFound", () => set(uuid, null)),
        // Asked about again, it is read again.
        Effect.catch((error) => Effect.logDebug("could not read a chat's badge", { reason: error.message })),
        reads.withPermits(1),
        Effect.ensuring(Effect.sync(() => reading.delete(uuid))),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    }

    return Service.of({
      learn: Effect.fn("PacerBadges.learn")(function* (uuid, item) {
        const badge = PacerWire.badge(item)
        if (badge !== undefined) yield* set(uuid.toLowerCase(), badge)
      }),

      get: Effect.fn("PacerBadges.get")(function* (sessionIDs) {
        if (!(yield* offered)) return { items: [] }
        const items = yield* Effect.forEach(sessionIDs, (sessionID) => {
          const uuid = PacerSessionID.make(sessionID)
          keep(asked, uuid, sessionID)
          const badge = badges.get(uuid)
          if (badge !== undefined) return Effect.succeed([{ sessionID, badge }])
          return Effect.as(read(uuid), [])
        })
        return { items: items.flat() }
      }),

      forget: Effect.fn("PacerBadges.forget")(function* (sessionID) {
        const uuid = PacerSessionID.make(sessionID)
        badges.delete(uuid)
        if (asked.has(uuid) && (yield* offered)) yield* read(uuid)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [PacerHttp.node, PacerModels.node, Bus.node] })
