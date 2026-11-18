export * as PacerTools from "./tools.js"

import { ToolDefinition } from "@opencode/ai/effect"
import type { SessionID } from "@opencode/schema/session-id"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"
import { SessionEvent } from "../session/event.js"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHeaders } from "./headers.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"

// CPP's tools as a client of its API (CLIENT-GUIDE §4.3; the workspace's reference `docs/reference/cpp-tools-api.md`):
// each chat's own list of their definitions, the memory tools with them while the chat has memory, and their calls.
// CPP keeps a chat's copy frozen while its prompt cache is warm and makes a new one only where the cache is lost
// anyway, so a list is read again only at those points: the chat's first request, after its compaction, when its
// model changes, and when a model answer's `X-Pacer-Tools` names another version. What the model is offered from it
// is `PacerOffer`'s; this module stays when that changes. With a chat's start recorded (`SessionPromptStart`), its
// warm steps send the recorded tools: the list then decides only what a cold point records and what a reminder tells.

/** What a client needs to run one of CPP's tools: the list's `meta` of it. */
export const Meta = PacerModels.ToolMeta
export type Meta = PacerModels.ToolMeta

/**
 * The tools of an endpoint and their meta, from every capabilities read (`pacer.tools`) and list read there, kept
 * across restarts: the first chat after an upgrade, and a step resumed right after a restart, have their executors
 * before any chat's list is read. Keyed by the set-up address's root, as each address of a pair is the same CPP.
 */
export type Known = ReadonlyMap<string, Meta>

const KnownValue = Schema.Record(Schema.String, Meta)
const decodeKnown = Schema.decodeUnknownOption(KnownValue)
export const knownKey = (endpoint: PacerEndpoint.Endpoint) => `pacer:tools:${endpoint.home ?? endpoint.root}`

/** A tool CPP names without meta, as one before it did: asked as its own name, on `*`. */
export const fallback = (name: string): Meta => ({ title: name, permission: name, subject: [], read_only: false })

/** Chats whose list is held; past it the least recently used one goes, and is read again at its next request. */
export const CHATS = 1_000
/** A list read waits at most this long. */
export const READ_TIMEOUT = Duration.seconds(5)
/** After a failed list read, no list a chat holds is read again for this long. */
export const PAUSE = Duration.seconds(30)
/**
 * A chat with earlier steps that holds no list waits for CPP's answer: it reads again this long after a read that got
 * none, then `RETRY` after each later one, for up to `WAIT` from its first read.
 */
export const RETRY_FIRST = Duration.seconds(3)
export const RETRY = Duration.seconds(5)
export const WAIT = Duration.minutes(1)
/** A call waits at most this long; CPP's longest is 3 attempts of 30 s, or a job's 50 s wait. */
export const CALL_TIMEOUT = Duration.minutes(2)
/** A file's ask and its sending wait this long: 20 MB may take a while, and the model waits for the call. */
export const UPLOAD_TIMEOUT = Duration.seconds(60)
/**
 * How long a file CPP was found to hold is taken as held without asking again. CPP drops a file no review round names
 * after 7 days (a call that failed after its upload), so a process that runs for weeks asks again, one HEAD, rather
 * than send a hash CPP no longer has.
 */
export const HELD = Duration.hours(1)

/** A chat's list as CPP answered it. One object per version, shared by every chat that holds it. */
export interface List {
  /** CPP's `version`: the first 16 hex digits of the definitions' SHA-256. */
  readonly version: string
  /** The definitions in CPP's order, from its `claude` shape: name, description and input schema as written. */
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly byName: ReadonlyMap<string, ToolDefinition>
  /** Each listed tool's meta, or {@link fallback}'s. */
  readonly meta: Known
}

export interface ListInput {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /** The chat's project headers (`PacerProject`). */
  readonly project?: Readonly<Record<string, string>>
  /** The model the request goes to, as CPP's `model`. */
  readonly model: string
  /**
   * Whether the request is one of the chat's steps. Only a step reads the list again for another model or a stale
   * one; a compaction or one-off generation carries the list the chat's steps hold, whatever its own model.
   */
  readonly step: boolean
  /**
   * Whether the chat has earlier steps: its history holds a model answer. Such a chat that holds no list, as after a
   * restart, waits for CPP's answer, since going without the tools would cost it its prompt cache; a new chat reads once.
   */
  readonly continues: boolean
}

export interface CallInput {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /** The chat's project headers (`PacerProject`). */
  readonly project?: Readonly<Record<string, string>>
  readonly name: string
  /** The agent the chat runs as: who asks (`X-Pacer-Agent`, with the chat's own id). */
  readonly agent?: string
  /** The model's arguments, sent as the body as they are. */
  readonly args: unknown
}

/** The task a chat is inside and its subtask, as CPP keeps them; null for none. */
export interface Place {
  readonly task: string
  readonly subtask: string | null
}

/**
 * A call's answer: `{text, data, error, metadata, place}`. A failed call is an answer too, with `error` and a `text`
 * for the model. `place` is the chat's place after the call, for the memory tools only: undefined when CPP sent none.
 */
export interface Answer {
  readonly text: string
  readonly data: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly metadata: Readonly<Record<string, unknown>>
  readonly place?: Place | null
}

/** A call CPP did not answer with `{text, data, error}`. */
export class CallError extends Schema.TaggedError<CallError>()("PacerTools.CallError", {
  /** `invalid`: CPP named problems in the arguments (400); `unknown`: no such tool (404). */
  reason: Schema.Literals(["invalid", "unknown", "unreachable", "refused", "unexpected"]),
  message: Schema.String,
}) {}

export interface Interface {
  /** The chat's list, read from CPP only when due; undefined when CPP offers none. Never fails. */
  readonly list: (input: ListInput) => Effect.Effect<List | undefined>
  /** A model answer's `X-Pacer-Tools`: another version than the held one is read at the chat's next step. */
  readonly seen: (sessionID: SessionID, version: string | undefined) => void
  readonly call: (input: CallInput) => Effect.Effect<Answer, CallError>
  /**
   * Makes sure CPP holds a file's bytes, by its SHA-256: `HEAD /pacer/v1/files/{sha256}` answers 200 when it does, and
   * a 404 is followed by a `PUT` of them. A file this process sent once is not asked after again.
   */
  readonly upload: (bytes: Uint8Array, mime: string, sha256: string) => Effect.Effect<void, PacerHttp.Error>
  /** The tools the current endpoint's lists named, with their meta; empty without an endpoint. */
  readonly known: () => Effect.Effect<Known>
  readonly knownChanges: () => Stream.Stream<Known>
  /** Whether the list the chat holds names the tool; undefined while it holds none, as before its first read. */
  readonly holds: (sessionID: SessionID, name: string) => boolean | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerTools") {}

const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.Record(Schema.String, Schema.Json),
})
const decodeDefinition = Schema.decodeUnknownOption(Definition)
const ListAnswer = Schema.Struct({
  version: Schema.String,
  tools: Schema.Struct({ claude: Schema.Array(Schema.Unknown) }),
  meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeMeta = Schema.decodeUnknownOption(Meta)
const PlaceAnswer = Schema.NullOr(
  Schema.Struct({ task: Schema.String, subtask: Schema.optional(Schema.NullOr(Schema.String)) }),
)
const decodePlace = Schema.decodeUnknownOption(PlaceAnswer)
const CallAnswer = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
  place: Schema.optional(Schema.Unknown),
})
const Failure = Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.NullOr(Schema.String)) })
const decodeFailure = Schema.decodeUnknownOption(Failure)

interface Chat {
  /** Undefined for a chat that is not a subagent. */
  readonly parentID: SessionID | undefined
  list?: List
  /** The model the held list was read for. */
  model?: string
  stale: boolean
  /** Counts the events that make the list stale, so one during a read leaves it stale. */
  generation: number
  reading?: Deferred.Deferred<Read>
}

/** A list read's outcome: `answered` is false when CPP gave no definite answer (no answer, a 5xx, a 429, …). */
interface Read {
  readonly list: List | undefined
  readonly answered: boolean
  readonly reason?: string
}
const none: Read = { list: undefined, answered: true }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const bus = yield* Bus.Service
    const kv = yield* KV.Service
    const scope = yield* Scope.Scope

    const load = (endpoint: PacerEndpoint.Endpoint | undefined) =>
      endpoint === undefined
        ? Effect.succeed<Known>(new Map())
        : kv
            .get(knownKey(endpoint))
            .pipe(
              Effect.map((value): Known => new Map(Object.entries(Option.getOrElse(decodeKnown(value), () => ({}))))),
            )
    const known = yield* SubscriptionRef.make<Known>(yield* load(yield* endpoints.get()))
    /**
     * Adds what a list or capabilities read from the current endpoint names; kept only when it changed something. A
     * Code Mode tool's definition is one for every chat: capabilities' replaces the held one, and a list's (whose bytes
     * are that chat's copy) only fills one missing, so chats' copies don't take turns in the catalog.
     */
    const learn = (endpoint: PacerEndpoint.Endpoint | undefined, meta: Known, from: "capabilities" | "list") =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(known)
        const fresh = [...meta].flatMap(([name, item]): Array<[string, Meta]> => {
          const held = current.get(name)
          const next =
            from === "list" && item.codemode === true && held?.definition !== undefined
              ? { ...item, definition: held.definition }
              : item
          return held === undefined || JSON.stringify(held) !== JSON.stringify(next) ? [[name, next]] : []
        })
        if (fresh.length === 0 || endpoint === undefined) return
        const next: Known = new Map([...current, ...fresh])
        yield* SubscriptionRef.set(known, next)
        yield* kv.set(knownKey(endpoint), Object.fromEntries(next))
      })

    // The files this process knows CPP holds, with when it learnt so: a picture given again within HELD is neither asked
    // after nor sent again.
    const files = new Map<string, number>()

    // In use order, the least recently used first.
    const chats = new Map<SessionID, Chat>()
    const versions = new Map<string, { readonly list: List; holders: number }>()
    const state = {
      endpoint: yield* endpoints.get(),
      /** Counts endpoint changes; a read that began before one is dropped. */
      epoch: 0,
      pausedUntil: 0,
      /** The endpoint answered the list's path with a 404: it has no web tools until the catalog or endpoint changes. */
      absent: false,
      /** Done at the next endpoint change, which ends every chat's wait. */
      changed: Deferred.makeUnsafe<void>(),
    }

    const release = (list: List | undefined) => {
      const held = list && versions.get(list.version)
      if (!held) return
      held.holders--
      if (held.holders === 0) versions.delete(list.version)
    }
    const drop = (sessionID: SessionID) => {
      release(chats.get(sessionID)?.list)
      chats.delete(sessionID)
    }
    const touch = (input: { readonly sessionID: SessionID; readonly parentID?: SessionID }) => {
      const found = chats.get(input.sessionID)
      chats.delete(input.sessionID)
      const chat = found ?? { parentID: input.parentID, stale: false, generation: 0 }
      chats.set(input.sessionID, chat)
      if (chats.size > CHATS) drop(chats.keys().next().value!)
      return chat
    }
    const stale = (chat: Chat) => {
      chat.stale = true
      chat.generation++
    }
    const hold = (chat: Chat, answer: typeof ListAnswer.Type) => {
      const version = answer.version
      if (chat.list?.version === version) return chat.list
      const held = versions.get(version) ?? { list: parse(answer), holders: 0 }
      versions.set(version, held)
      held.holders++
      release(chat.list)
      chat.list = held.list
      return held.list
    }

    /** One read, shared by the chat's requests; `quiet` leaves a failure's warning to the caller. */
    const read = (chat: Chat, input: ListInput, quiet: boolean) =>
      Effect.gen(function* () {
        if (chat.reading) return yield* Deferred.await(chat.reading)
        const result = Deferred.makeUnsafe<Read>()
        const generation = chat.generation
        const epoch = state.epoch
        chat.reading = result
        // Done before a waiter resumes, so the chat's next request finds no read under way.
        const done = (read: Read) =>
          Effect.sync(() => {
            if (chat.reading === result) chat.reading = undefined
            Deferred.doneUnsafe(result, Exit.succeed(read))
          })
        // Shared by the chat's requests that wait for it, so it outlives the one that started it.
        yield* http
          .get(`/pacer/v1/tools?model=${encodeURIComponent(input.model)}&include=memory`, ListAnswer, {
            timeout: READ_TIMEOUT,
            headers: PacerHeaders.chat({ sessionID: input.sessionID, parentID: chat.parentID, project: input.project }),
          })
          .pipe(
            Effect.flatMap((answer) =>
              Effect.sync((): Read => {
                if (epoch !== state.epoch) return none
                // A chat deleted or pushed out meanwhile holds nothing; this request still gets the list.
                if (chats.get(input.sessionID) !== chat)
                  return {
                    list: versions.get(answer.body.version)?.list ?? parse(answer.body),
                    answered: true,
                  }
                const list = hold(chat, answer.body)
                chat.model = input.model
                if (chat.generation === generation) chat.stale = false
                return { list, answered: true }
              }).pipe(
                Effect.tap((read) =>
                  read.list && epoch === state.epoch ? learn(state.endpoint, read.list.meta, "list") : Effect.void,
                ),
              ),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (epoch !== state.epoch) return none
                if (error._tag === "PacerHttp.NoPacer") {
                  state.absent = true
                  return none
                }
                // CPP never answers this path with its own 404 (cpa-server web_tools/mod.rs, `client`): one would be
                // about this chat, so only it goes without, and reads again at its next request.
                if (error._tag === "PacerHttp.NotFound") {
                  if (chats.get(input.sessionID) === chat) {
                    release(chat.list)
                    chat.list = undefined
                    chat.model = undefined
                  }
                  return none
                }
                if (error._tag !== "PacerHttp.NotSetUp")
                  state.pausedUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(PAUSE)
                if (!quiet) yield* Effect.logWarning("could not read CLIProxyPacer's tools", { reason: error.message })
                // A refused key or no CPP set up is an answer; nothing else from it is.
                const answered = error._tag === "PacerHttp.Refused" || error._tag === "PacerHttp.NotSetUp"
                return { list: chat.list, answered, reason: error.message }
              }),
            ),
            Effect.flatMap(done),
            Effect.ensuring(done(none)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        return yield* Deferred.await(result)
      })

    const offered = Effect.gen(function* () {
      if (!(yield* endpoints.get())) return false
      // A catalog not read yet reads anyway: a step resumed right after a restart gets the tools it had.
      const catalog = yield* catalogs.get()
      if (catalog && !catalog.pacer?.webTools && !catalog.pacer?.memory?.tools) return false
      return !state.absent
    })

    const list = Effect.fn("PacerTools.list")(function* (input: ListInput) {
      if (!(yield* offered)) return undefined
      const chat = touch(input)
      const due = !chat.list || (input.step && (chat.stale || chat.model !== input.model))
      // A chat that holds no list, as every chat right after a restart, reads through the pause: going without its
      // tools would cost it its prompt cache because another chat's read failed first.
      if (!due || (chat.list && (yield* Clock.currentTimeMillis) < state.pausedUntil)) return chat.list
      if (chat.list || !input.continues) return (yield* read(chat, input, false)).list
      return yield* wait(chat, input)
    })

    /** Reads until CPP answers, the endpoint changes, or no read would start within `WAIT` of the first. */
    const wait = Effect.fnUntraced(function* (chat: Chat, input: ListInput) {
      const begun = yield* Clock.currentTimeMillis
      const epoch = state.epoch
      const changed = Deferred.await(state.changed)
      for (let retry = RETRY_FIRST; ; retry = RETRY) {
        const result = yield* Effect.raceFirst(read(chat, input, true), Effect.as(changed, none))
        if (result.answered || result.list) return result.list
        const now = yield* Clock.currentTimeMillis
        if (now + Duration.toMillis(retry) > begun + Duration.toMillis(WAIT)) {
          yield* Effect.logWarning("went on without CLIProxyPacer's tools: no answer to their list", {
            sessionID: input.sessionID,
            waited: Duration.format(Duration.millis(now - begun)),
            reason: result.reason,
          })
          return undefined
        }
        yield* Effect.raceFirst(Effect.sleep(retry), changed)
        if (state.epoch !== epoch || !(yield* offered)) return undefined
      }
    })

    const call = Effect.fn("PacerTools.call")(function* (input: CallInput) {
      const answer = yield* http
        .post(`/pacer/v1/tools/${encodeURIComponent(input.name)}`, input.args, CallAnswer, {
          timeout: CALL_TIMEOUT,
          headers: PacerHeaders.chat(input),
        })
        .pipe(
          Effect.mapError((error) => {
            // An old copy of the list may name a tool CPP no longer has: the chat's next step reads it again.
            if (error._tag === "PacerHttp.NotFound" || error._tag === "PacerHttp.NoPacer") {
              const chat = chats.get(input.sessionID)
              if (chat) stale(chat)
            }
            return failed(input.name, error)
          }),
        )
      const error = answer.body.error ?? undefined
      const failure = Option.getOrUndefined(decodeFailure(error))
      const metadata = answer.body.metadata
      const place = answer.body.place === undefined ? undefined : Option.getOrUndefined(decodePlace(answer.body.place))
      return {
        text: answer.body.text ?? "",
        data: answer.body.data,
        ...(error === undefined ? {} : { error: { code: failure?.code ?? "error", message: failure?.message ?? "" } }),
        metadata: typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? { ...metadata } : {},
        ...(place === undefined ? {} : { place: place && { task: place.task, subtask: place.subtask ?? null } }),
      } satisfies Answer
    })

    yield* endpoints.changes().pipe(
      Stream.runForEach((endpoint) =>
        Effect.gen(function* () {
          if (PacerEndpoint.same(endpoint, state.endpoint)) return
          const previous = state.endpoint
          state.endpoint = endpoint
          // Another address of the pair is the same CPP with the same lists: each chat keeps the one it read. What
          // paused reads was the old address's outage.
          if (PacerEndpoint.sameServer(endpoint, previous)) {
            state.pausedUntil = 0
            return
          }
          // Another address or key is another server: nothing read from the last one holds, and neither do its files.
          state.epoch++
          state.pausedUntil = 0
          state.absent = false
          chats.clear()
          versions.clear()
          files.clear()
          Deferred.doneUnsafe(state.changed, Exit.void)
          state.changed = Deferred.makeUnsafe<void>()
          const loaded = yield* load(endpoint)
          if (PacerEndpoint.same(endpoint, state.endpoint)) yield* SubscriptionRef.set(known, loaded)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // The catalog is the current endpoint's: another endpoint's is dropped before its first read there.
    yield* catalogs.changes().pipe(
      Stream.runForEach((catalog) =>
        Effect.gen(function* () {
          state.absent = false
          const tools = catalog?.pacer?.tools
          if (tools) yield* learn(yield* endpoints.get(), tools, "capabilities")
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* bus.subscribe([SessionEvent.Compaction.Ended, SessionEvent.Deleted]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "session.deleted") return drop(event.data.sessionID)
          const chat = chats.get(event.data.sessionID)
          if (chat) stale(chat)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      list,
      seen: (sessionID, version) => {
        if (version === undefined) return
        const chat = chats.get(sessionID)
        if (chat?.list && chat.list.version !== version) stale(chat)
      },
      call,
      upload: (bytes, mime, sha256) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const known = files.get(sha256)
          if (known !== undefined && now - known < Duration.toMillis(HELD)) return
          const path = `/pacer/v1/files/${sha256}`
          const status = yield* http.head(path, { timeout: UPLOAD_TIMEOUT })
          // CPP's files route answers 200 or 404: anything else means it is not there to keep them.
          if (status !== 200 && status !== 404)
            return yield* new PacerHttp.Unexpected({ status, reason: `HEAD of ${path} answered ${status}` })
          if (status === 404) yield* http.put(path, bytes, mime, { timeout: UPLOAD_TIMEOUT })
          files.set(sha256, now)
        }),
      known: () => SubscriptionRef.get(known),
      knownChanges: () => SubscriptionRef.changes(known),
      holds: (sessionID, name) => chats.get(sessionID)?.list?.byName.has(name),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  // Not Session: it imports, through the session context, the model request that uses this.
  deps: [PacerEndpoint.node, PacerHttp.node, PacerModels.node, Bus.node, KV.node],
})

/**
 * A version's definitions and their meta, each one on its own: an entry this version does not understand drops only
 * itself, and a tool without meta it understands is asked as {@link fallback} says.
 */
function parse(answer: typeof ListAnswer.Type): List {
  const entries = answer.tools.claude.flatMap((entry) => Option.toArray(decodeDefinition(entry)))
  const definitions = entries.map(
    (item) => new ToolDefinition({ name: item.name, description: item.description, inputSchema: item.input_schema }),
  )
  return {
    version: answer.version,
    definitions,
    byName: new Map(definitions.map((item) => [item.name, item])),
    meta: new Map(
      entries.map((item) => {
        const meta = Option.getOrElse(decodeMeta(answer.meta?.[item.name]), () => fallback(item.name))
        // A Code Mode tool is described in the catalog by its definition, which the list holds beside its meta.
        if (meta.codemode !== true || meta.definition !== undefined) return [item.name, meta]
        return [item.name, { ...meta, definition: { description: item.description, input_schema: item.input_schema } }]
      }),
    ),
  }
}

function failed(name: string, error: PacerHttp.Error) {
  switch (error._tag) {
    case "PacerHttp.Unexpected":
      return error.status === 400
        ? new CallError({
            reason: "invalid",
            message: `CLIProxyPacer refused the arguments of ${name}: ${error.reason}`,
          })
        : new CallError({ reason: "unexpected", message: error.message })
    case "PacerHttp.NotFound":
    case "PacerHttp.NoPacer":
      return new CallError({ reason: "unknown", message: `CLIProxyPacer has no tool ${name}` })
    case "PacerHttp.Refused":
      return new CallError({ reason: "refused", message: error.message })
    case "PacerHttp.Unreachable":
      return new CallError({ reason: "unreachable", message: `CLIProxyPacer could not be reached: ${error.reason}` })
    case "PacerHttp.NotSetUp":
      return new CallError({ reason: "unreachable", message: error.message })
  }
}
