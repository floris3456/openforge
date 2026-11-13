export * as PacerTools from "./tools.js"

import { ToolDefinition } from "@opencode/ai/effect"
import type { SessionID } from "@opencode/schema/session-id"
import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHeaders } from "./headers.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"

// CPP's web tools as a client of its API (CLIENT-GUIDE §4.3): each chat's own list of their definitions, and their
// calls. CPP keeps a chat's copy frozen while its prompt cache is warm and makes a new one only where the cache is lost
// anyway, so a list is read again only at those points: the chat's first request, after its compaction, when its
// model changes, and when a model answer's `X-Pacer-Tools` names another version. What the model is offered from it
// is `PacerOffer`'s; this module stays when that changes.

/** CPP's four web tools (WEB-TOOLS.md, "The tools' parameters"). */
export const names = ["web_search", "web_extract", "web_crawl", "web_research"] as const

/** Chats whose list is held; past it the least recently used one goes, and is read again at its next request. */
export const CHATS = 1_000
/** A list read waits at most this long. */
export const READ_TIMEOUT = Duration.seconds(5)
/** After a failed list read, no list a chat holds is read again for this long. */
export const PAUSE = Duration.seconds(30)
/** A call waits at most this long; CPP's longest is 3 attempts of 30 s, or a job's 50 s wait. */
export const CALL_TIMEOUT = Duration.minutes(2)

/** A chat's list as CPP answered it. One object per version, shared by every chat that holds it. */
export interface List {
  /** CPP's `version`: the first 16 hex digits of the definitions' SHA-256. */
  readonly version: string
  /** The definitions in CPP's order, from its `claude` shape: name, description and input schema as written. */
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly byName: ReadonlyMap<string, ToolDefinition>
}

export interface ListInput {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /** The model the request goes to, as CPP's `model`. */
  readonly model: string
  /**
   * Whether the request is one of the chat's steps. Only a step reads the list again for another model or a stale
   * one; a compaction or one-off generation carries the list the chat's steps hold, whatever its own model.
   */
  readonly step: boolean
}

export interface CallInput {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  readonly name: string
  /** The model's arguments, sent as the body as they are. */
  readonly args: unknown
}

/** A call's answer: `{text, data, error}`. A failed call is an answer too, with `error` and a `text` for the model. */
export interface Answer {
  readonly text: string
  readonly data: unknown
  readonly error?: { readonly code: string; readonly message: string }
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerTools") {}

const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.Record(Schema.String, Schema.Unknown),
})
const decodeDefinition = Schema.decodeUnknownOption(Definition)
const ListAnswer = Schema.Struct({
  version: Schema.String,
  tools: Schema.Struct({ claude: Schema.Array(Schema.Unknown) }),
})
const CallAnswer = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
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
  reading?: Deferred.Deferred<List | undefined>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

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
    const hold = (chat: Chat, version: string, entries: ReadonlyArray<unknown>) => {
      if (chat.list?.version === version) return chat.list
      const held = versions.get(version) ?? { list: parse(version, entries), holders: 0 }
      versions.set(version, held)
      held.holders++
      release(chat.list)
      chat.list = held.list
      return held.list
    }

    const read = (chat: Chat, input: ListInput) =>
      Effect.gen(function* () {
        if (chat.reading) return yield* Deferred.await(chat.reading)
        const result = Deferred.makeUnsafe<List | undefined>()
        const generation = chat.generation
        const epoch = state.epoch
        chat.reading = result
        // Done before a waiter resumes, so the chat's next request finds no read under way.
        const done = (list: List | undefined) =>
          Effect.sync(() => {
            if (chat.reading === result) chat.reading = undefined
            Deferred.doneUnsafe(result, Exit.succeed(list))
          })
        // Shared by the chat's requests that wait for it, so it outlives the one that started it.
        yield* http
          .get(`/pacer/v1/tools?model=${encodeURIComponent(input.model)}`, ListAnswer, {
            timeout: READ_TIMEOUT,
            headers: PacerHeaders.chat({ sessionID: input.sessionID, parentID: chat.parentID }),
          })
          .pipe(
            Effect.flatMap((answer) =>
              Effect.sync(() => {
                if (epoch !== state.epoch) return undefined
                // A chat deleted or pushed out meanwhile holds nothing; this request still gets the list.
                if (chats.get(input.sessionID) !== chat)
                  return versions.get(answer.body.version)?.list ?? parse(answer.body.version, answer.body.tools.claude)
                const list = hold(chat, answer.body.version, answer.body.tools.claude)
                chat.model = input.model
                if (chat.generation === generation) chat.stale = false
                return list
              }),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (epoch !== state.epoch) return undefined
                if (error._tag === "PacerHttp.NoPacer" || error._tag === "PacerHttp.NotFound") {
                  state.absent = true
                  return undefined
                }
                if (error._tag !== "PacerHttp.NotSetUp")
                  state.pausedUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(PAUSE)
                yield* Effect.logWarning("could not read CLIProxyPacer's web tools", { reason: error.message })
                return chat.list
              }),
            ),
            Effect.flatMap(done),
            Effect.ensuring(done(undefined)),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        return yield* Deferred.await(result)
      })

    const list = Effect.fn("PacerTools.list")(function* (input: ListInput) {
      if (!(yield* endpoints.get())) return undefined
      // A catalog not read yet reads anyway: a step resumed right after a restart gets the tools it had.
      const catalog = yield* catalogs.get()
      if (catalog && !catalog.pacer?.webTools) return undefined
      if (state.absent) return undefined
      const chat = touch(input)
      const due = !chat.list || (input.step && (chat.stale || chat.model !== input.model))
      // A chat that holds no list, as every chat right after a restart, reads through the pause: going without its
      // tools would cost it its prompt cache because another chat's read failed first.
      if (!due || (chat.list && (yield* Clock.currentTimeMillis) < state.pausedUntil)) return chat.list
      return yield* read(chat, input)
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
      return {
        text: answer.body.text ?? "",
        data: answer.body.data,
        ...(error === undefined ? {} : { error: { code: failure?.code ?? "error", message: failure?.message ?? "" } }),
      } satisfies Answer
    })

    yield* endpoints.changes().pipe(
      Stream.runForEach((endpoint) =>
        Effect.sync(() => {
          if (PacerEndpoint.same(endpoint, state.endpoint)) return
          // Another address or key is another server: nothing read from the last one holds.
          state.endpoint = endpoint
          state.epoch++
          state.pausedUntil = 0
          state.absent = false
          chats.clear()
          versions.clear()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* catalogs.changes().pipe(
      Stream.runForEach(() => Effect.sync(() => void (state.absent = false))),
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
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  // Not Session: it imports, through the session context, the model request that uses this.
  deps: [PacerEndpoint.node, PacerHttp.node, PacerModels.node, Bus.node],
})

/** A version's definitions, each one on its own: an entry this version does not understand drops only itself. */
function parse(version: string, entries: ReadonlyArray<unknown>): List {
  const definitions = entries.flatMap((entry) =>
    Option.toArray(decodeDefinition(entry)).map(
      (item) => new ToolDefinition({ name: item.name, description: item.description, inputSchema: item.input_schema }),
    ),
  )
  return { version, definitions, byName: new Map(definitions.map((item) => [item.name, item])) }
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
