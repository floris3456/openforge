export * as PacerConnection from "./connection.js"

import { isDeepStrictEqual } from "node:util"
import { Clock, Context, Effect, Layer, Queue, Result, Schema, Stream } from "effect"
import { makeParser } from "effect/encoding/Sse"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { Model } from "@opencode/schema/model"
import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { Bus } from "../bus.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"
import { PacerSessionID } from "./session-id.js"
import { PacerWire } from "./wire.js"

// The service's one connection to CPP, which every TUI reads through the `pacer.*` routes of `server.experimental`.
// It follows CPP's change stream, reads the accounts, the chats' views and their requests, sets the chats' switches,
// tells CPP of the chats' events, and publishes the `pacer.*` events (`Pacer.Event`). Fields may be added; none may be
// removed or renamed without the server's handler and the TUI.
//
// What it costs: the session events of every chat reach it, and a chat CPP does not know costs one map lookup per
// event. All of CPP's reads and writes run beside the chats, never in a step's path: a chat with work is put on one
// queue (once, however often it is marked), which `READERS` fibers drain; a chat's work runs in order and reads its
// view at most once per drain, so the reads after many steps coalesce. Notices coalesce the same way, one pending read
// per kind. Nothing runs on a timer while CPP is up: when no chat runs, the only traffic is the open stream.

/** CPP can't answer now: it isn't set up, is unreachable, or has no pacer, and nothing read before can stand in. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("PacerConnection.Unavailable", {
  state: Pacer.State,
  reason: Schema.String,
}) {
  override get message() {
    return `CLIProxyPacer can't answer: ${this.reason}`
  }
}

export interface RequestsInput {
  readonly filter: Pacer.Filter
  /** The `cursor` of the page before, for the next, older page. */
  readonly cursor?: string
  /** Rows per page: 50 when absent, at most 500. */
  readonly limit?: number
}

export interface Interface {
  /** The connection now. Never waits on CPP. */
  readonly status: () => Effect.Effect<Pacer.Status>
  /**
   * Every account the key sees, as last held. Never waits on CPP: the meters come with the state read at each connect,
   * before the pacer is on, and are read again after CPP's `reading` notices. Undefined before the first read since
   * CPP was set up.
   */
  readonly accounts: () => Effect.Effect<Pacer.Accounts | undefined>
  /**
   * The chat's view, held from the last read (its `asOf` says when). A held view is answered at once; when it is out
   * of date (after a reconnect, or CPP's `reading` or `settings` notices) and the pacer is on, it is read again in the
   * background, and `pacer.chat.updated` follows if it changed. A held chat that CPP's list shows with requests the
   * view hasn't seen (a ping, a compaction, another client's step) is read again at once; one openforge compacted
   * drops its "compacts at" at once. With none held, a chat CPP is known to have is read now; any other is answered
   * undefined at once and looked up in the background (`pacer.chat.updated` when CPP has it). Undefined when CPP
   * knows nothing of the chat, or nothing was read while CPP can't answer.
   */
  readonly chat: (sessionID: SessionID) => Effect.Effect<Pacer.Chat | undefined>
  /** Sets the chat's switches on CPP and answers its view after the change. */
  readonly update: (sessionID: SessionID, input: Pacer.ChatUpdate) => Effect.Effect<Pacer.Chat, Unavailable>
  /**
   * One page of the chat's requests with its subagents', newest first, always read from CPP: the TUI holds the first
   * page itself and reads it again on `pacer.requests.updated`.
   */
  readonly requests: (sessionID: SessionID, input: RequestsInput) => Effect.Effect<Pacer.Requests, Unavailable>
  /**
   * What changed in one request's prompt (`Pacer.Request.id`): from the last 50 read, else read from CPP. Undefined
   * when CPP has no request with that ID for the key.
   */
  readonly prompt: (requestID: string) => Effect.Effect<Pacer.PromptChange | undefined, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerConnection") {}

/** The first wait before connecting again; it doubles after each failed or short-lived try, up to the most. */
export const RECONNECT_MS = 1_000
export const MAX_RECONNECT_MS = 30_000
/** CPP sends a heartbeat every 25 s; a stream silent this long is gone. */
export const SILENCE_MS = 60_000
/** The meters are read again at most this often. */
export const METERS_MS = 10_000
/** `pings.duration_minutes` while a chat waits on a foreground command or a subagent. */
export const WAIT_MINUTES = 240
/** Fibers that run the chats' work, and so the most reads and writes to CPP at once for them. */
export const READERS = 4
/** Chats held at most; the oldest without pending work go first. */
export const CHATS = 1_000
/** What-changed answers held. */
export const PROMPTS = 50
/** CPP's UUIDs of chats with new requests this service didn't know yet, held at most. */
export const UNNAMED = 200

const provider: string = PacerEndpoint.id

const followed = [
  SessionEvent.Step.Started,
  SessionEvent.Step.Streamed,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Deleted,
  SessionEvent.ModelSelected,
  SessionEvent.AgentSelected,
  SessionEvent.Renamed,
  SessionEvent.RevertEvent.Staged,
  SessionEvent.Compaction.Ended,
] as const
type Followed = Bus.SubscribePayload<typeof followed>

/** The events that end a chat's pings; each is told once until the chat's next step. */
type Stopping = "closed" | "compacted" | "reverted" | "agent_switched"
type ChatEvent =
  | { readonly type: Stopping }
  | { readonly type: "model_changed"; readonly model: string | null }
  | { readonly type: "label"; readonly label: string }

interface Info {
  readonly parentID?: SessionID
  readonly agent?: string
  readonly title?: string
}

/** One chat this service holds something for. */
interface Chat {
  readonly sessionID: SessionID
  /** Its UUID on CPP (`X-Pacer-Session`). */
  readonly uuid: string
  /** CPP has it: a step of it went through CPP, or CPP named it. Events of any other chat are not followed. */
  on: boolean
  /** Its current step goes through CPP. */
  step: boolean
  /** From the session store, read once; undefined until then. */
  info: Info | undefined
  /** Its title as last seen, when renamed since `info` was read. */
  title: string | undefined
  /** CPP's view as last read or merged, and the same in openforge's shape. */
  raw: PacerWire.View | undefined
  view: Pacer.Chat | undefined
  /** The view may be out of date. */
  stale: boolean
  /** CPP's requests and account generation for it as last read or listed (`PacerWire.marks`). */
  marks: string | undefined
  /** A read of the view is due. */
  read: boolean
  /** CPP knew nothing of it at the last read. */
  missing: boolean
  /** CPP's number for it, for the request reads. */
  storeID: number | undefined
  /** Foreground shell and subagent calls by call ID, from their start until they end. */
  readonly calls: Map<string, string>
  /** The calls of `calls` being waited on. */
  readonly waits: Set<string>
  /** `pings.duration_minutes` as CPP holds it, when known. */
  duration: number | null | undefined
  /** CPP's label for it, as last read or told. */
  label: string | undefined
  /** Its last `model_changed`: the model, or null for another provider's. */
  model: string | null | undefined
  /** Events to tell CPP, in order; one per type. */
  events: ChatEvent[]
  /** The stopping events told since its last step. */
  readonly stopped: Set<Stopping>
  /** A subagent's run ended before `info` was read. */
  ended: boolean
  /** Deleted: forgotten once its events are told. */
  removed: boolean
  /** CPP asked to compact it (`named`), or to look whether it asks (`check`). */
  compact: "named" | "check" | undefined
  /** Its subagents were looked up for its request rows. */
  children: boolean
  /** CPP recorded requests of it before this service knew it: the TUIs are told once its parents are known. */
  requests: boolean
}

/** The connection's own state. */
interface Link {
  endpoint: PacerEndpoint.Endpoint | undefined
  status: Pacer.Status
  /** When CPP last answered. */
  contact: number | undefined
  /** CPP's clock minus the service's: the middle of `bounds`. */
  offset: number
  /**
   * What CPP's answers say of it together: each answer's bounds (`Date` has whole seconds), intersected over every
   * answer since this CPP was set up, reconnects included, so the times shown hold still. Undefined before the first.
   */
  bounds: PacerHttp.Offset | undefined
  accounts: Pacer.Accounts | undefined
  /** Account aliases by `auth_index`, from the meters. */
  aliases: Map<string, string>
  /** The UUIDs of the chats CPP listed as active. */
  active: Set<string>
  /** The newest request row seen. */
  newest: number | undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const endpoints = yield* PacerEndpoint.Service
    const models = yield* PacerModels.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    const link: Link = {
      endpoint: undefined,
      status: { state: "unset", since: yield* Clock.currentTimeMillis, refused: false },
      contact: undefined,
      offset: 0,
      bounds: undefined,
      accounts: undefined,
      aliases: new Map(),
      active: new Set(),
      newest: undefined,
    }
    const chats = new Map<SessionID, Chat>()
    const byUuid = new Map<string, SessionID>()
    const prompts = new Map<string, Pacer.PromptChange>()
    // A chat's first requests can reach CPP, and its notice this service, before the chat's step is published here: a
    // new chat's title and first step, or a chat continued after a restart.
    const unnamed = new Set<string>()

    const on = () => link.status.state === "on"
    const context = () => Effect.map(Clock.currentTimeMillis, (now) => ({ offset: link.offset, now }))
    const alias = (account: string) => link.aliases.get(account) ?? account

    const contact = (offset: PacerHttp.Offset | undefined) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        link.contact = now
        if (offset === undefined) return
        const held = link.bounds
        const low = held ? Math.max(held.low, offset.low) : offset.low
        const high = held ? Math.min(held.high, offset.high) : offset.high
        // Bounds that no longer meet: a clock jumped, CPP's or this one's. They start over from this answer.
        link.bounds = low <= high ? { low, high } : offset
        link.offset = Math.round((link.bounds.low + link.bounds.high) / 2)
      })

    const setStatus = Effect.fnUntraced(function* (next: {
      readonly state: Pacer.State
      readonly message?: string
      readonly refused?: boolean
    }) {
      const current = link.status
      const refused = next.refused === true
      if (current.state === next.state && current.message === next.message && current.refused === refused) return
      const now = yield* Clock.currentTimeMillis
      link.status = {
        state: next.state,
        since: current.state === next.state ? current.since : now,
        ...(link.contact !== undefined ? { asOf: link.contact } : {}),
        ...(next.message ? { message: next.message } : {}),
        refused,
      }
      yield* bus.publish(Pacer.Event.StatusChanged, { status: link.status })
    })

    const unavailable = (error?: PacerHttp.Error) =>
      new Unavailable({
        state: link.status.state,
        reason:
          error?.message ??
          (link.status.state === "unset"
            ? "it is not set up"
            : link.status.state === "no-pacer"
              ? "this proxy has no pacer"
              : (link.status.message ?? "it is unreachable")),
      })
    const requireOn = Effect.suspend(() => (on() ? Effect.void : Effect.fail(unavailable())))

    const get = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        if (!link.endpoint) return yield* new PacerHttp.NotSetUp()
        const answer = yield* http.get(path, schema, { endpoint: link.endpoint })
        yield* contact(answer.offset)
        return answer.body
      })
    const send = <A, I>(method: "patch" | "post", path: string, body: unknown, schema: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        if (!link.endpoint) return yield* new PacerHttp.NotSetUp()
        const answer = yield* http[method](path, body, schema, { endpoint: link.endpoint })
        yield* contact(answer.offset)
        return answer.body
      })
    const sessionPath = (chat: Chat) => `/pacer/v1/sessions/${encodeURIComponent(chat.uuid)}`

    // ------------------------------------------------------------------ the chats held

    const ready = yield* Queue.unbounded<SessionID>()
    const queued = new Set<SessionID>()
    const running = new Set<SessionID>()
    const again = new Set<SessionID>()

    /** Puts the chat's work on the queue, once; a chat marked while its work runs runs again after. */
    const mark = (chat: Chat) => {
      if (running.has(chat.sessionID)) return void again.add(chat.sessionID)
      if (queued.has(chat.sessionID)) return
      queued.add(chat.sessionID)
      Queue.offerUnsafe(ready, chat.sessionID)
    }

    const pending = (chat: Chat) =>
      chat.requests ||
      chat.events.length > 0 ||
      chat.read ||
      chat.ended ||
      chat.compact !== undefined ||
      (chat.waits.size > 0 ? chat.duration !== WAIT_MINUTES : chat.duration === WAIT_MINUTES)

    const busy = (chat: Chat) =>
      pending(chat) || chat.waits.size > 0 || queued.has(chat.sessionID) || running.has(chat.sessionID)

    const forget = (chat: Chat) => {
      chats.delete(chat.sessionID)
      byUuid.delete(chat.uuid)
    }

    /** The chat, held from now on and moved to the newest end. */
    const touch = (sessionID: SessionID) => {
      const found = chats.get(sessionID)
      if (found) {
        chats.delete(sessionID)
        chats.set(sessionID, found)
        return found
      }
      const uuid = PacerSessionID.make(sessionID)
      const chat: Chat = {
        sessionID,
        uuid,
        on: false,
        step: false,
        info: undefined,
        title: undefined,
        raw: undefined,
        view: undefined,
        stale: false,
        marks: undefined,
        read: false,
        missing: false,
        storeID: undefined,
        calls: new Map(),
        waits: new Set(),
        duration: undefined,
        label: undefined,
        model: undefined,
        events: [],
        stopped: new Set(),
        ended: false,
        removed: false,
        compact: undefined,
        children: false,
        requests: unnamed.delete(uuid),
      }
      chats.set(sessionID, chat)
      byUuid.set(chat.uuid, sessionID)
      if (chat.requests) mark(chat)
      if (chats.size > CHATS)
        for (const held of chats.values()) {
          if (chats.size <= CHATS) break
          if (!busy(held)) forget(held)
        }
      return chat
    }

    /** The chat when CPP has it; for the rare events of a chat not seen this run, also when CPP lists it. */
    const known = (sessionID: SessionID) => {
      const chat = chats.get(sessionID)
      if (chat?.on) return chat
      if (link.active.size === 0 || !link.active.has(PacerSessionID.make(sessionID))) return undefined
      const listed = touch(sessionID)
      listed.on = true
      return listed
    }

    const tell = (chat: Chat, event: ChatEvent) => {
      if (event.type !== "model_changed" && event.type !== "label") {
        if (chat.stopped.has(event.type)) return
        chat.stopped.add(event.type)
      }
      chat.events = [...chat.events.filter((item) => item.type !== event.type), event]
      mark(chat)
    }

    const close = (chat: Chat) => {
      tell(chat, { type: "closed" })
      chat.waits.clear()
      chat.calls.clear()
      chat.raw = undefined
      chat.view = undefined
    }

    const labelOf = (chat: Chat) => {
      const title = chat.title ?? chat.info?.title
      return title ? truncate(title, 200) : undefined
    }

    /** Converts the held view, and tells the TUIs when it changed. */
    const setView = Effect.fnUntraced(function* (chat: Chat) {
      if (!chat.raw) return
      const next = PacerWire.chat(chat.raw, chat.sessionID, { ...(yield* context()), alias })
      const changed = !chat.view || !isDeepStrictEqual({ ...chat.view, asOf: 0 }, { ...next, asOf: 0 })
      chat.view = next
      if (changed) yield* bus.publish(Pacer.Event.ChatUpdated, { chat: next })
    })

    /** Holds a view CPP answered. */
    const hold = Effect.fnUntraced(function* (chat: Chat, view: PacerWire.View) {
      chat.raw = view
      chat.on = true
      chat.stale = false
      chat.marks = PacerWire.marks(view) ?? chat.marks
      chat.missing = false
      if (typeof view.session_id === "number") chat.storeID = view.session_id
      const duration = view.settings?.["pings.duration_minutes"]
      if (typeof duration === "number" || duration === null) chat.duration = duration
      chat.label = typeof view.label === "string" ? view.label : undefined
      yield* setView(chat)
      const label = labelOf(chat)
      if (label && label !== chat.label) tell(chat, { type: "label", label })
      // A wait this process never saw end (it started in an earlier one) is ended here.
      if (chat.duration === WAIT_MINUTES && chat.waits.size === 0) mark(chat)
    })

    /**
     * Merges the live part of a chat CPP listed into its held view. What the list doesn't carry (when it compacts, the
     * next use, a forced move) changes with a request, a ping or a compaction among them, or a move: a chat whose
     * requests or generation moved is read again, through the chats' queue, once however often it is listed.
     */
    const merge = Effect.fnUntraced(function* (item: PacerWire.Listed) {
      const uuid = item.id.toLowerCase()
      link.active.add(uuid)
      const sessionID = byUuid.get(uuid)
      const chat = sessionID && chats.get(sessionID)
      if (!chat) return
      chat.on = true
      if (typeof item.session_id === "number") chat.storeID = item.session_id
      if (!chat.raw) return
      // A list read before the view held now is older than it.
      if (
        typeof item.requests === "number" &&
        typeof chat.raw.requests === "number" &&
        item.requests < chat.raw.requests
      )
        return
      const marks = PacerWire.marks(item)
      if (marks !== undefined && marks !== chat.marks) {
        chat.marks = marks
        chat.read = true
        mark(chat)
      }
      chat.raw = {
        ...chat.raw,
        warm: item.warm,
        warm_until: item.warm_until,
        pings: item.pings,
        ...(item.account ? { account: item.account } : {}),
        ...(item.model ? { model: item.model } : {}),
      }
      yield* setView(chat)
    })

    /** Whether CPP answered (else the work is left for the reconnect); a refused write is dropped. */
    const answered = (what: string) => (error: PacerHttp.Error) =>
      error._tag === "PacerHttp.Unreachable" || error._tag === "PacerHttp.NotSetUp"
        ? Effect.succeed(false)
        : Effect.logWarning(`CLIProxyPacer refused ${what}`, { reason: error.message }).pipe(Effect.as(true))

    const readView = (chat: Chat) =>
      get(sessionPath(chat), PacerWire.View).pipe(
        Effect.flatMap((view) => hold(chat, view)),
        Effect.as(true),
        Effect.catchTag("PacerHttp.NotFound", () =>
          Effect.sync(() => {
            chat.missing = true
            chat.raw = undefined
            chat.view = undefined
            return true
          }),
        ),
        Effect.catch(answered("a chat's view")),
      )

    const patch = (chat: Chat, body: Record<string, unknown>) =>
      send("patch", sessionPath(chat), body, PacerWire.View).pipe(
        Effect.flatMap((view) => hold(chat, view)),
        Effect.as(true),
        Effect.catch(answered("a chat's settings")),
      )

    const post = (chat: Chat, event: ChatEvent) =>
      send("post", `${sessionPath(chat)}/events`, event, Schema.Unknown).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (event.type === "label") chat.label = event.label
          }),
        ),
        Effect.as(true),
        Effect.catch(answered(`a chat's ${event.type} event`)),
      )

    const lookup = (sessionID: SessionID) =>
      sessions.get(sessionID).pipe(
        Effect.map(
          (info): Info => ({
            ...(info.parentID ? { parentID: info.parentID } : {}),
            ...(info.agent ? { agent: info.agent } : {}),
            ...(info.title ? { title: info.title } : {}),
          }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      )

    /**
     * The models to compact the chat with, first choice first, or why it must not be compacted now: a step running or
     * queued keeps it warm. Only its own model on CPP reads its warm cache (spec section 6), never a compaction model
     * set elsewhere: the one its last answer came from, then the one selected since, if another on CPP.
     */
    const compactWith = Effect.fnUntraced(function* (sessionID: SessionID) {
      if ((yield* sessions.active).has(sessionID)) return "it is running"
      const inbox = yield* sessions.inbox(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (inbox === undefined) return "it is gone"
      if (inbox.length > 0) return "it has queued input"
      // Session.compact would commit a staged revert first.
      const info = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (info?.revert) return "it has a staged revert"
      if (info?.model && info.model.providerID !== provider) return "its model is no longer on CPP"
      const [last] = yield* sessions
        .messages({ sessionID, type: "assistant", order: "desc", limit: 1 })
        .pipe(Effect.orElseSucceed(() => []))
      const answered = last?.type === "assistant" && last.model.providerID === provider ? last.model : undefined
      const models: Model.Ref[] = []
      for (const model of [answered, info?.model])
        if (model && !models.some((pick) => sameModel(pick, model))) models.push(model)
      return models.length > 0 ? models : "its last answer did not come through CPP"
    })

    const compact = Effect.fnUntraced(function* (chat: Chat) {
      const ask = chat.compact
      chat.compact = undefined
      if (ask === "check" && chat.view?.compactAt === undefined) return
      const models = yield* compactWith(chat.sessionID)
      if (typeof models === "string")
        return yield* Effect.logInfo(`CLIProxyPacer asked to compact a chat; left alone: ${models}`, {
          sessionID: chat.sessionID,
        })
      yield* sessions.compact({ sessionID: chat.sessionID, models }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not compact a chat CLIProxyPacer asked to", {
            sessionID: chat.sessionID,
            reason: error.message,
          }),
        ),
      )
    })

    /** The chat and its parents, from the store where not held: a subagent's requests are also its parents'. */
    const lineage = Effect.fnUntraced(function* (sessionID: SessionID) {
      const ids: SessionID[] = []
      for (let id: SessionID | undefined = sessionID; id && ids.length < 8; ) {
        ids.push(id)
        const held = chats.get(id)
        if (held && held.info === undefined) held.info = yield* lookup(id)
        id = held?.info?.parentID
      }
      return ids
    })

    const requestsUpdated = (sessionIDs: Iterable<SessionID>) =>
      Effect.forEach(sessionIDs, (sessionID) => bus.publish(Pacer.Event.RequestsUpdated, { sessionID }), {
        discard: true,
      })

    /** One chat's work, in order: its events, its waits' duration, a read of its view, a compaction. */
    const work = Effect.fnUntraced(function* (chat: Chat) {
      if (!on()) return
      if (chat.info === undefined) chat.info = yield* lookup(chat.sessionID)
      if (chat.requests) {
        chat.requests = false
        yield* requestsUpdated(yield* lineage(chat.sessionID))
      }
      if (chat.ended) {
        chat.ended = false
        if (chat.info.parentID) close(chat)
      }
      while (chat.events.length > 0) {
        if (!(yield* post(chat, chat.events[0]))) return
        chat.events = chat.events.slice(1)
      }
      if (chat.removed) return forget(chat)
      const want = chat.waits.size > 0 ? WAIT_MINUTES : null
      if (want === null ? chat.duration === WAIT_MINUTES : chat.duration !== WAIT_MINUTES) {
        if (!(yield* patch(chat, { "pings.duration_minutes": want }))) return
        // The answer is the view.
        chat.read = false
      }
      if (chat.read) {
        chat.read = false
        if (!(yield* readView(chat))) return void (chat.read = true)
      }
      if (chat.compact) yield* compact(chat)
    })

    yield* Effect.forEach(
      Array.from({ length: READERS }, () => undefined),
      () =>
        Queue.take(ready).pipe(
          Effect.flatMap((sessionID) => {
            queued.delete(sessionID)
            const chat = chats.get(sessionID)
            if (!chat) return Effect.void
            running.add(sessionID)
            return work(chat).pipe(
              Effect.catchCause((cause) => Effect.logWarning("CLIProxyPacer: a chat's work failed", cause)),
              Effect.ensuring(
                Effect.sync(() => {
                  running.delete(sessionID)
                  if (again.delete(sessionID)) mark(chat)
                }),
              ),
            )
          }),
          Effect.forever,
          Effect.forkScoped,
        ),
      { discard: true },
    )

    // ------------------------------------------------------------------ the reads after notices

    /** A read run by one fiber, one pending at a time however often it is asked for; `gap` rests between two. */
    const trigger = Effect.fnUntraced(function* (name: string, run: Effect.Effect<void, PacerHttp.Error>, gap = 0) {
      const asked = yield* Queue.dropping<void>(1)
      yield* Queue.take(asked).pipe(
        Effect.andThen(
          Effect.suspend(() => (on() ? run : Effect.void)).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`CLIProxyPacer: reading ${name} failed`, cause)),
          ),
        ),
        Effect.andThen(gap > 0 ? Effect.sleep(gap) : Effect.void),
        Effect.forever,
        Effect.forkScoped,
      )
      return () => void Queue.offerUnsafe(asked, undefined)
    })

    const setAccounts = Effect.fnUntraced(function* (meters: ReadonlyArray<PacerWire.Meter>) {
      link.aliases = new Map(meters.map((meter) => [meter.auth_index, meter.label || meter.auth_index]))
      const next = PacerWire.accounts(meters, yield* context())
      const changed = !link.accounts || !isDeepStrictEqual({ ...link.accounts, asOf: 0 }, { ...next, asOf: 0 })
      link.accounts = next
      if (changed) yield* bus.publish(Pacer.Event.AccountsUpdated, { accounts: next })
    })

    const staleViews = () => {
      for (const chat of chats.values()) if (chat.raw) chat.stale = true
    }

    const readMeters = Effect.gen(function* () {
      const meters = yield* get("/pacer/v1/meters", PacerWire.Meters)
      // Where a chat goes next depends on the meters.
      staleViews()
      yield* setAccounts(PacerWire.meters(meters))
    })

    const readSessions = Effect.gen(function* () {
      const answer = yield* get("/pacer/v1/sessions?limit=100", PacerWire.Sessions)
      const items = PacerWire.listed(answer.items)
      link.active = new Set()
      for (const item of items) yield* merge(item)
      return items
    })

    const readNew = Effect.gen(function* () {
      const query = link.newest === undefined ? "limit=50" : `after=${link.newest}&limit=500`
      const answer = yield* get(`/pacer/v1/monitor/requests?${query}&from=0`, PacerWire.Rows)
      const rows = PacerWire.rows(answer.items)
      link.newest = Math.max(link.newest ?? 0, ...rows.map((row) => row.id))
      const found = new Set<SessionID>()
      // Oldest first, so that the newest stay held.
      for (const row of rows.toReversed()) {
        const uuid = row.session_ext?.toLowerCase()
        if (!uuid) continue
        const sessionID = byUuid.get(uuid)
        if (sessionID) found.add(sessionID)
        else {
          // Told once this service holds the chat (Chat.requests); another client's chats stay here until pushed out.
          unnamed.delete(uuid)
          unnamed.add(uuid)
          for (const oldest of unnamed) {
            if (unnamed.size <= UNNAMED) break
            unnamed.delete(oldest)
          }
        }
      }
      const named = new Set<SessionID>()
      for (const sessionID of found) for (const id of yield* lineage(sessionID)) named.add(id)
      yield* requestsUpdated(named)
      // More rows than one read takes: every TUI reads again.
      if (typeof answer.next === "string") yield* bus.publish(Pacer.Event.RequestsUpdated, {})
    })

    const readState = Effect.gen(function* () {
      yield* applyState(yield* get("/pacer/v1/state", PacerWire.State))
    })

    const applyState = Effect.fnUntraced(function* (state: typeof PacerWire.State.Type) {
      yield* setAccounts(PacerWire.meters(state.meters))
      const found = PacerWire.active(state)
      link.active = new Set(found.numbers.keys())
      for (const [uuid, number] of found.numbers) {
        const sessionID = byUuid.get(uuid)
        const chat = sessionID && chats.get(sessionID)
        if (!chat) continue
        chat.on = true
        chat.storeID = number
      }
      for (const item of found.live) yield* merge(item)
      staleViews()
    })

    const requests = yield* trigger("the new requests", readNew)
    const listing = yield* trigger("the chats", Effect.asVoid(readSessions))
    const meters = yield* trigger("the meters", readMeters, METERS_MS)
    const capabilities = yield* trigger("the capabilities", models.refresh())
    const everything = yield* trigger(
      "everything",
      Effect.all([readState, models.refresh()], { concurrency: "unbounded", discard: true }).pipe(
        Effect.andThen(Effect.sync(requests)),
      ),
    )
    const askAll = yield* trigger(
      "the chats CPP asks to compact",
      Effect.gen(function* () {
        for (const item of yield* readSessions) {
          const sessionID = byUuid.get(item.id.toLowerCase())
          const chat = sessionID && chats.get(sessionID)
          if (!chat) continue
          chat.compact = "check"
          chat.read = true
          mark(chat)
        }
      }),
    )

    /** A chat CPP names that this run has not seen: one of the newest sessions, if any. */
    const find = Effect.fnUntraced(function* (uuid: string) {
      const page = yield* sessions.list({ limit: 200 }).pipe(Effect.orElseSucceed(() => ({ data: [] })))
      const info = page.data.find((item) => PacerSessionID.make(item.id) === uuid)
      return info && touch(info.id)
    })

    const notice = Effect.fnUntraced(function* (event: string, data: string) {
      if (event === "request") return requests()
      if (event === "session") return listing()
      if (event === "reading") return meters()
      // Settings change what CPP answers for the chats (and CPP sends one for a chat's own writes too); capabilities and
      // prices have notices of their own. A stale view costs nothing until a chat is asked for.
      if (event === "settings") return staleViews()
      if (event === "price" || event === "capabilities") return capabilities()
      if (event === "resync") return everything()
      if (event !== "compact") return
      const asked = PacerWire.notice(data)
      if (asked.many) askAll()
      for (const uuid of asked.sessions) {
        const sessionID = byUuid.get(uuid)
        const chat = sessionID ? chats.get(sessionID) : yield* find(uuid)
        if (!chat) continue
        chat.on = true
        chat.compact = "named"
        mark(chat)
      }
    })

    // ------------------------------------------------------------------ the connection

    const reset = (endpoint: PacerEndpoint.Endpoint | undefined) => {
      link.endpoint = endpoint
      link.contact = undefined
      // Another CPP has its own clock.
      link.offset = 0
      link.bounds = undefined
      link.accounts = undefined
      link.aliases = new Map()
      link.active = new Set()
      link.newest = undefined
      prompts.clear()
      unnamed.clear()
      // Another CPP knows nothing of what this one said.
      for (const chat of chats.values()) {
        chat.raw = undefined
        chat.view = undefined
        chat.stale = false
        chat.marks = undefined
        chat.read = false
        chat.missing = false
        chat.storeID = undefined
        chat.duration = undefined
        chat.label = undefined
        chat.model = undefined
        chat.events = []
        chat.compact = undefined
        chat.requests = false
      }
    }

    /** One connection: the state, then the stream until it ends. Fails when CPP can't be read. */
    const attempt = (endpoint: PacerEndpoint.Endpoint, first: boolean) =>
      Effect.gen(function* () {
        // The views first, then the stream: nothing is replayed after a reconnect. A proxy without the pacer answers
        // this read 404 or 503 `unavailable` (PacerHttp.NoPacer).
        yield* readState
        // The pacer answered: it is on, while its stream connects. CPP sends the stream's headers at once and its first
        // bytes with the first heartbeat, 25 s on; a proxy in front may hold the headers until those bytes, so they are
        // waited for as long as a heartbeat. Nothing is lost meanwhile: CPP queues the notices on the stream asked for,
        // and they are its first bytes. A stream that fails turns the state unreachable as any read.
        yield* setStatus({ state: "on" })
        // The first time the catalog reads itself, on the endpoint's change; after a reconnect it is read again.
        if (!first) capabilities()
        for (const chat of chats.values()) if (pending(chat)) mark(chat)
        const stream = yield* http.stream("/pacer/v1/stream", { endpoint, timeout: SILENCE_MS })
        yield* contact(stream.offset)
        const events: Array<{ readonly event: string; readonly data: string }> = []
        const parser = makeParser((event) => {
          if (event._tag === "Event") events.push(event)
        })
        yield* stream.body.pipe(
          Stream.timeout(SILENCE_MS),
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.gen(function* () {
              yield* contact(undefined)
              if (parser.feed(text)) return yield* new PacerHttp.Unexpected({ reason: "the change stream is not SSE" })
              for (const item of events.splice(0)) yield* notice(item.event, item.data)
            }),
          ),
          // A stream that breaks has ended; reading again says whether CPP is still there.
          Effect.catch(() => Effect.void),
        )
      })

    const follow = Effect.fnUntraced(function* (endpoint: PacerEndpoint.Endpoint) {
      let delay = RECONNECT_MS
      for (let first = true; ; first = false) {
        const begun = yield* Clock.currentTimeMillis
        const result = yield* attempt(endpoint, first).pipe(Effect.result)
        if (Result.isFailure(result)) {
          const error = result.failure
          if (error._tag === "PacerHttp.NotSetUp") return yield* Effect.never
          // A refused key is tried again only once the address or the key changes.
          if (error._tag === "PacerHttp.Refused") {
            yield* setStatus({ state: "unreachable", message: error.message, refused: true })
            return yield* Effect.never
          }
          if (error._tag === "PacerHttp.NoPacer") {
            yield* setStatus({ state: "no-pacer", message: error.reason })
            yield* pacerBack
            delay = RECONNECT_MS
            continue
          }
          yield* setStatus({ state: "unreachable", message: error.message })
          yield* Effect.sleep(Math.max(delay, error._tag === "PacerHttp.Unreachable" ? (error.retryAfter ?? 0) : 0))
        }
        if (Result.isSuccess(result)) {
          // A stream that lasted is a working connection: its end starts the waits from a second again.
          if ((yield* Clock.currentTimeMillis) - begun >= MAX_RECONNECT_MS) delay = RECONNECT_MS
          // The status stays on until a read fails.
          yield* Effect.sleep(delay)
        }
        delay = Math.min(delay * 2, MAX_RECONNECT_MS)
      }
    })

    /** Waits for a later catalog read that finds the pacer (the provider reads it again, as the model picker opens). */
    const pacerBack = models.changes().pipe(
      // The catalog held now said nothing new: CPP has just answered without its pacer.
      Stream.drop(1),
      Stream.filter((catalog) => catalog !== undefined && catalog.pacer !== null),
      Stream.runHead,
    )

    yield* endpoints.changes().pipe(
      Stream.changesWith(PacerEndpoint.same),
      Stream.switchMap((endpoint) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            reset(endpoint)
            if (!endpoint) return yield* setStatus({ state: "unset" })
            return yield* follow(endpoint)
          }),
        ),
      ),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    )

    // ------------------------------------------------------------------ the chats' events

    const observe = (event: Followed) => {
      const sessionID = event.data.sessionID
      switch (event.type) {
        case "session.step.started": {
          const cpp = event.data.model.providerID === provider
          const chat = cpp ? touch(sessionID) : chats.get(sessionID)
          if (!chat) return
          chat.step = cpp
          if (!cpp) return
          chat.on = true
          chat.missing = false
          chat.stopped.clear()
          if (chat.info === undefined) mark(chat)
          return
        }
        case "session.step.streamed": {
          const chat = chats.get(sessionID)
          if (!chat?.step) return
          chat.read = true
          return mark(chat)
        }
        case "session.tool.input.started": {
          const chat = chats.get(sessionID)
          if (!chat?.step || (event.data.name !== "shell" && event.data.name !== "subagent")) return
          chat.calls.set(event.data.id, event.data.name)
          return
        }
        case "session.tool.called": {
          const chat = chats.get(sessionID)
          if (!chat?.calls.has(event.data.id)) return
          // A background shell or subagent does not hold the chat: a dev server would keep it warm for hours.
          if (event.data.input.background === true) return void chat.calls.delete(event.data.id)
          chat.waits.add(event.data.id)
          if (chat.waits.size === 1) mark(chat)
          return
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const chat = chats.get(sessionID)
          if (!chat?.calls.delete(event.data.id)) return
          if (chat.waits.delete(event.data.id) && chat.waits.size === 0) mark(chat)
          return
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          // A shutdown or a run taken over ends nothing.
          if (
            event.type === "session.execution.interrupted" &&
            (event.data.reason === "shutdown" || event.data.reason === "superseded")
          )
            return
          const chat = chats.get(sessionID)
          if (!chat?.on) return
          // A run that ended waits on nothing, also when it stopped before a call's end was published.
          chat.calls.clear()
          if (chat.waits.size > 0) {
            chat.waits.clear()
            mark(chat)
          }
          // Only a subagent's run ending closes its chat on CPP.
          if (chat.info === undefined) {
            chat.ended = true
            return mark(chat)
          }
          if (chat.info.parentID) close(chat)
          return
        }
        case "session.deleted": {
          const chat = known(sessionID)
          if (!chat) return
          close(chat)
          chat.removed = true
          return mark(chat)
        }
        case "session.model.selected": {
          const chat = known(sessionID)
          if (!chat) return
          const model = event.data.model.providerID === provider ? event.data.model.id : null
          if (chat.model === model) return
          chat.model = model
          return tell(chat, { type: "model_changed", model })
        }
        case "session.agent.selected": {
          const chat = known(sessionID)
          if (!chat || event.data.agent === event.data.previous) return
          return tell(chat, { type: "agent_switched" })
        }
        case "session.renamed": {
          const chat = known(sessionID)
          if (!chat) return
          chat.title = event.data.title
          const label = labelOf(chat)
          if (label && label !== chat.label) tell(chat, { type: "label", label })
          return
        }
        case "session.revert.staged": {
          const chat = known(sessionID)
          return chat && tell(chat, { type: "reverted" })
        }
        case "session.compaction.ended": {
          const chat = known(sessionID)
          if (!chat) return
          // CPP's view is read again for what it plans next; one through another provider is told first, CPP saw one
          // that went through it.
          chat.read = true
          if (event.data.model?.providerID === provider) mark(chat)
          else tell(chat, { type: "compacted" })
          // The compaction CPP planned is done: "compacts at" goes at once, not when CPP's view says so.
          if (!chat.raw?.warming?.compact_at) return
          chat.raw = { ...chat.raw, warming: { ...chat.raw.warming, compact_at: null, compact_reason: null } }
          return setView(chat)
        }
      }
    }

    yield* bus.subscribe(followed).pipe(
      Stream.runForEach((event) => Effect.suspend(() => observe(event) ?? Effect.void)),
      Effect.forkScoped({ startImmediately: true }),
    )

    // ------------------------------------------------------------------ the routes

    /** Who sent each row: the chats by CPP's UUID, and their agents; a chat's subagents are looked up once. */
    const senders = Effect.fnUntraced(function* (chat: Chat | undefined, rows: ReadonlyArray<PacerWire.Row>) {
      const exts = new Set(rows.flatMap((row) => (row.session_ext ? [row.session_ext.toLowerCase()] : [])))
      if (chat && !chat.children && [...exts].some((ext) => !byUuid.has(ext))) {
        chat.children = true
        yield* descendants(chat.sessionID)
      }
      const found = new Map<string, PacerWire.Sender>()
      for (const ext of exts) {
        const sessionID = byUuid.get(ext)
        const held = sessionID && chats.get(sessionID)
        if (!held) continue
        if (held.info === undefined) held.info = yield* lookup(held.sessionID)
        found.set(ext, { sessionID: held.sessionID, ...(held.info.agent ? { agent: held.info.agent } : {}) })
      }
      return (row: PacerWire.Row) => (row.session_ext ? (found.get(row.session_ext.toLowerCase()) ?? {}) : {})
    })

    /** Holds the chat's subagents, three levels down, so their rows name them. */
    const descendants = Effect.fnUntraced(function* (root: SessionID) {
      let level = [root]
      for (let depth = 0; depth < 3 && level.length > 0; depth++) {
        const pages = yield* Effect.forEach(
          level,
          (parentID) =>
            sessions.list({ parentID, limit: 200 }).pipe(
              Effect.map((page) => page.data),
              Effect.orElseSucceed(() => []),
            ),
          { concurrency: READERS },
        )
        const children = pages.flat()
        for (const child of children) {
          const held = touch(child.id)
          held.info ??= {
            ...(child.parentID ? { parentID: child.parentID } : {}),
            ...(child.agent ? { agent: child.agent } : {}),
            ...(child.title ? { title: child.title } : {}),
          }
        }
        level = children.map((child) => child.id)
      }
    })

    const remember = (requestID: string, change: Pacer.PromptChange) => {
      prompts.delete(requestID)
      prompts.set(requestID, change)
      for (const key of prompts.keys()) {
        if (prompts.size <= PROMPTS) break
        prompts.delete(key)
      }
    }

    const oneRow = (request: string | number) =>
      get(
        `/pacer/v1/monitor/requests?request=${encodeURIComponent(String(request))}&limit=1&from=0`,
        PacerWire.Rows,
      ).pipe(Effect.map((answer) => PacerWire.rows(answer.items)[0]))

    return Service.of({
      status: () =>
        Effect.sync(() => (on() && link.contact !== undefined ? { ...link.status, asOf: link.contact } : link.status)),
      accounts: () => Effect.sync(() => link.accounts),
      chat: (sessionID) =>
        Effect.gen(function* () {
          const chat = touch(sessionID)
          if (chat.view) {
            if (chat.stale && on()) {
              chat.read = true
              mark(chat)
            }
            return chat.view
          }
          if (!on() || chat.missing) return undefined
          if (!chat.on && !link.active.has(chat.uuid)) {
            chat.read = true
            mark(chat)
            return undefined
          }
          yield* readView(chat)
          return chat.view
        }),
      update: (sessionID, input) =>
        Effect.gen(function* () {
          yield* requireOn
          const chat = touch(sessionID)
          const view = yield* send(
            "patch",
            sessionPath(chat),
            {
              ...(input.warming !== undefined ? { "pings.enabled": input.warming } : {}),
              ...(input.compactBeforeCold !== undefined
                ? { "warming.compact_before_cold": input.compactBeforeCold }
                : {}),
            },
            PacerWire.View,
          ).pipe(Effect.mapError(unavailable))
          yield* hold(chat, view)
          return chat.view ?? PacerWire.chat(view, sessionID, { ...(yield* context()), alias })
        }),
      requests: (sessionID, input) =>
        Effect.gen(function* () {
          yield* requireOn
          const chat = touch(sessionID)
          if (chat.storeID === undefined && !chat.missing) yield* readView(chat)
          const now = yield* context()
          if (chat.storeID === undefined) return { items: [], asOf: now.now }
          const query = new URLSearchParams({
            session: String(chat.storeID),
            children: "1",
            from: "0",
            limit: String(Math.min(Math.max(input.limit ?? 50, 1), 500)),
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.filter === "misses" ? { verdict: "miss,partial" } : {}),
          })
          const answer = yield* get(`/pacer/v1/monitor/requests?${query}`, PacerWire.Rows).pipe(
            Effect.mapError(unavailable),
          )
          const rows = PacerWire.rows(answer.items)
          const sender = yield* senders(chat, rows)
          return {
            items: rows.map((row) => PacerWire.request(row, sender(row), now)),
            ...(answer.next ? { cursor: answer.next } : {}),
            asOf: now.now,
          }
        }),
      prompt: (requestID) =>
        Effect.gen(function* () {
          const held = prompts.get(requestID)
          if (held) {
            remember(requestID, held)
            return held
          }
          yield* requireOn
          const [prompt, row] = yield* Effect.all(
            [
              get(`/pacer/v1/prompts/${encodeURIComponent(requestID)}?rows=1`, PacerWire.Prompt).pipe(
                Effect.catchTag("PacerHttp.NotFound", () => Effect.succeed(undefined)),
              ),
              oneRow(requestID),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.mapError(unavailable))
          if (!row) return undefined
          const compared = row.cache_base ?? prompt?.previous ?? undefined
          const base =
            compared === undefined ? undefined : yield* oneRow(compared).pipe(Effect.orElseSucceed(() => undefined))
          const sessionID = row.session_ext ? byUuid.get(row.session_ext.toLowerCase()) : undefined
          const sender = yield* senders(sessionID && chats.get(sessionID), [row])
          const now = yield* context()
          const change = PacerWire.promptChange(prompt, PacerWire.request(row, sender(row), now), base, now)
          // CPP may store a prompt just after its request's row: an answer without one is not kept.
          if (change.kept !== "none") remember(requestID, change)
          return change
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [PacerEndpoint.node, PacerHttp.node, PacerModels.node, Bus.node, Session.node],
})

/** At most `bytes` bytes of UTF-8, cut at a character. */
function truncate(text: string, bytes: number) {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= bytes) return text
  return new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/\uFFFD$/u, "")
}

function sameModel(a: Model.Ref, b: Model.Ref) {
  return a.id === b.id && a.providerID === b.providerID && a.variant === b.variant
}
