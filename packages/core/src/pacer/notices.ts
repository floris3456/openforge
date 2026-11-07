export * as PacerNotices from "./notices.js"

import { Clock, Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { Bus } from "../bus.js"
import { Session } from "../session.js"
import { PacerWire } from "./wire.js"

// The service's cache notices (spec cliproxypacer-cache-notices, sections 1 and 2): each miss or partial reuse of CPP's
// prompt cache by a step or a compaction of one of this service's chats, a subagent's included. They come from the
// request rows the connection reads on CPP's `request` notices (`PacerConnection`), so nothing more is read from CPP,
// and are held in memory for every TUI: a restart of the service starts with none. Each TUI shows those its own
// settings let through, and dismisses them here, so that a dismissal reaches every TUI. Nothing runs on a timer: what
// grew too old goes when rows come in or the list is read.

/** Notices held at most, the dismissed ones included; the oldest go first. */
export const HELD = 50
/** None older than this is held: the longest lifetime a TUI can set. */
export const LIFETIME_MS = 2 * 3_600_000
/** Rows of chats this service doesn't hold yet that wait for it, at most; the oldest go first. */
export const WAITING = 50
/** Chats above a subagent's looked up at most, for its top chat. */
const DEPTH = 8

export interface Interface {
  /** The notices held and not dismissed, newest first. */
  readonly list: () => Effect.Effect<ReadonlyArray<Pacer.Notice>>
  /**
   * Dismisses the request's notice in every TUI: `pacer.notice.dismissed` tells them, once. A request with no notice
   * held is told too, so that a TUI still showing one drops it.
   */
  readonly dismiss: (requestID: string) => Effect.Effect<void>
  /**
   * Looks at request rows the connection read. Each miss or partial reuse of a step or a compaction becomes a notice,
   * told as `pacer.notice.added`, when `chat` names the chat by CPP's UUID; one of a chat it doesn't name waits until
   * {@link Interface.named} names it. Rows CPP received before this service started, or longer ago than `LIFETIME_MS`,
   * raise none.
   */
  readonly read: (
    rows: ReadonlyArray<PacerWire.Row>,
    chat: (uuid: string) => SessionID | undefined,
    context: PacerWire.Context,
  ) => Effect.Effect<void>
  /** This service holds the chat CPP knows as `uuid` now: its rows that waited raise their notices. */
  readonly named: (uuid: string, sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerNotices") {}

interface Held {
  readonly notice: Pacer.Notice
  dismissed: boolean
}

interface Found {
  readonly request: Pacer.Request
  readonly sessionID: SessionID
}

/** The notices over the session store and the bus; {@link layer} holds one for the service. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const sessions = yield* Session.Service
  // A row CPP received before this service started was the one before's to tell: a dismissed notice doesn't come back
  // with the first rows read after a restart.
  const started = yield* Clock.currentTimeMillis
  // Newest first.
  const held: Held[] = []
  // Oldest first, with the chat's UUID on CPP.
  let waiting: Array<{ readonly uuid: string; readonly request: Pacer.Request }> = []

  const recent = (request: Pacer.Request, now: number) => request.at >= started && request.at >= now - LIFETIME_MS
  const prune = (now: number) => {
    while (held.length > 0 && held[held.length - 1].notice.at < now - LIFETIME_MS) held.pop()
    waiting = waiting.filter((item) => recent(item.request, now))
  }
  const holds = (requestID: string) => held.some((entry) => entry.notice.requestID === requestID)

  /** The request's notice; undefined when its chat is gone from the store. */
  const shape = Effect.fnUntraced(function* (request: Pacer.Request, sessionID: SessionID) {
    const info = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
    if (!info) return undefined
    let rootID = sessionID
    for (let parentID = info.parentID, depth = 0; parentID && depth < DEPTH; depth++) {
      rootID = parentID
      parentID = (yield* sessions.get(parentID).pipe(Effect.orElseSucceed(() => undefined)))?.parentID
    }
    return {
      requestID: request.id,
      sessionID,
      rootID,
      ...(info.title ? { title: info.title } : {}),
      ...(info.agent ? { agent: info.agent } : {}),
      model: request.model,
      verdict: request.verdict === "partial" ? "partial" : "miss",
      ...(request.rewritten !== undefined ? { tokens: request.rewritten } : {}),
      cause: Pacer.causeText(request) || "unknown cause",
      ...(request.missCost !== undefined ? { missCost: request.missCost } : {}),
      at: request.at,
    } satisfies Pacer.Notice
  })

  /** Holds the requests' notices, oldest given first, and tells those still held after the oldest went. */
  const add = Effect.fnUntraced(function* (found: ReadonlyArray<Found>) {
    const now = yield* Clock.currentTimeMillis
    prune(now)
    const added: Pacer.Notice[] = []
    for (const item of found) {
      if (!recent(item.request, now) || holds(item.request.id)) continue
      const notice = yield* shape(item.request, item.sessionID)
      // Looked up meanwhile by another read.
      if (!notice || holds(notice.requestID)) continue
      held.unshift({ notice, dismissed: false })
      added.push(notice)
    }
    if (added.length === 0) return
    // Of two at the same time, the one read later stays first.
    held.sort((a, b) => b.notice.at - a.notice.at)
    held.splice(HELD)
    for (const notice of added)
      if (held.some((entry) => entry.notice === notice)) yield* bus.publish(Pacer.Event.NoticeAdded, { notice })
  })

  return Service.of({
    list: () =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        prune(now)
        return held.flatMap((entry) => (entry.dismissed ? [] : [entry.notice]))
      }),
    dismiss: (requestID) =>
      Effect.gen(function* () {
        const entry = held.find((item) => item.notice.requestID === requestID)
        if (entry?.dismissed) return
        if (entry) entry.dismissed = true
        yield* bus.publish(Pacer.Event.NoticeDismissed, { requestID })
      }),
    read: (rows, chat, context) =>
      Effect.gen(function* () {
        const found: Found[] = []
        for (const row of rows.toSorted((a, b) => a.id - b.id)) {
          const uuid = row.session_ext?.toLowerCase()
          if (!uuid) continue
          const request = PacerWire.request(row, {}, context)
          if (request.kind !== "step" && request.kind !== "compaction") continue
          if (request.verdict !== "miss" && request.verdict !== "partial") continue
          const sessionID = chat(uuid)
          if (sessionID) {
            found.push({ request, sessionID })
            continue
          }
          if (!recent(request, context.now)) continue
          waiting.push({ uuid, request })
          waiting.splice(0, waiting.length - WAITING)
        }
        yield* add(found)
      }),
    named: (uuid, sessionID) =>
      Effect.suspend(() => {
        const mine = waiting.filter((item) => item.uuid === uuid)
        if (mine.length === 0) return Effect.void
        waiting = waiting.filter((item) => item.uuid !== uuid)
        return add(mine.map((item) => ({ request: item.request, sessionID })))
      }),
  })
})

export const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node, Session.node] })
