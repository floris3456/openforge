export * as PacerSummaries from "./summaries.js"

import { ai, AIError, LanguageModel, LLMRequest, type Message } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAICompatibleResponses } from "@opencode/ai/protocols"
import type { HttpMiddleware } from "@opencode/ai/route"
import type { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"
import { PacerSessionID } from "./session-id.js"
import { PacerStatus } from "./status.js"
import { PacerWire } from "./wire.js"

// CLIProxyPacer writes the summaries (spec cliproxypacer-server-summaries): who writes the summary of a compaction of a
// chat on CPP, and how CPP's answer reads. The compaction itself (`session/compaction.ts`) sends the request; this
// reads the chat's view, the key level's settings and the catalog, and sets the chat's own writer, beside it. Not
// through the connection, whose state it reads from `PacerStatus`: compaction cannot depend on the session store the
// connection imports.

/**
 * How long openforge waits for CPP's summary before it writes its own: CPP gives a summary 180 s, and 20 s to its first
 * byte on a cheap model (the spec's decision).
 */
export const WAIT = "4 minutes"

/** The provider whose chats CPP writes summaries for: `PacerEndpoint.id`. */
export const provider: string = PacerEndpoint.id

/** Whether a chat's model sends its steps to CPP in the Messages format (CPP's Claude models), not Responses. */
export function messages(model: LanguageModel) {
  return model.route.protocol === AnthropicMessages.protocol.id
}

/**
 * The request a chat's next step would send, up to the recent part openforge keeps (`session/compaction.ts`), made a
 * `/responses/compact` request to CPP (spec section 3, "The body"): a Responses chat keeps its own route and model, so
 * the body is the start of the step's bytes as far as `/compact` takes them
 * (`OpenAICompatibleResponses.compact`); a Messages chat's is rendered by the Responses protocol at the same address
 * with the same key. Its Claude thinking, signed for Anthropic, is left out: Responses can't carry it.
 */
export function responses(request: LLMRequest) {
  const route = request.model.route
  const compact = { endpoint: OpenAICompatibleResponses.compact }
  const model =
    route.protocol === OpenAICompatibleResponses.route.protocol
      ? LanguageModel.update(request.model, { route: route.with({ compact }) })
      : OpenAICompatibleResponses.route
          .with({
            provider: route.provider ?? request.model.provider,
            providerMetadataKey: OpenAICompatibleResponses.route.providerMetadataKey,
            endpoint: { baseURL: route.endpoint.baseURL },
            auth: route.auth,
            compact,
          })
          .model({ id: request.model.id })
  const next = LLMRequest.update(request, { model })
  if (!ai.canCompact(next)) throw new Error("A route with a compact endpoint can compact")
  return next
}

/** What CPP's readable answer opens its summary with (`compaction_write.rs`, `SUMMARY_PREFIX`). */
export const PREFIX = "Context summary from previous turns:\n"

/** `X-Pacer-Compaction`, read. */
export interface Header {
  /** CPP wrote it on its cheaper model for a cold chat. */
  readonly cold: boolean
  /** The model that wrote it. */
  readonly model?: string
  /** `server` or `provider`. */
  readonly writer?: string
  /** How many of the user's own earlier messages CPP kept after it (`compaction.user_messages`). */
  readonly userMessages?: number
}

/**
 * `X-Pacer-Compaction` (CLIENT-GUIDE, "Answers a client gets back"): `warm|cold; model=<model>; writer=<writer>`, with
 * `; user_messages=<n>` when CPP kept the earlier user messages. Undefined when absent (lost when a buffered answer had
 * to send keep-alive bytes first) or not of that shape.
 */
export function header(value: string | undefined): Header | undefined {
  const [state, ...parts] = (value ?? "").split(";").map((part) => part.trim())
  const temperature = state?.toLowerCase()
  if (temperature !== "warm" && temperature !== "cold") return undefined
  const fields = new Map(
    parts.flatMap((part) => {
      const at = part.indexOf("=")
      return at > 0 ? [[part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()] as const] : []
    }),
  )
  const model = fields.get("model")
  const writer = fields.get("writer")
  const kept = fields.get("user_messages")
  const userMessages = kept !== undefined && /^\d+$/.test(kept) ? Number(kept) : undefined
  return {
    cold: temperature === "cold",
    ...(model ? { model } : {}),
    ...(writer ? { writer } : {}),
    ...(userMessages !== undefined ? { userMessages } : {}),
  }
}

/**
 * The summary in CPP's readable answer to `/responses/compact` (`compaction.writer = server`): the text of its user
 * message after {@link PREFIX}, the earlier user messages it kept included. Undefined without one: an opaque capsule
 * alone, as CPP answers Claude while the writer is unset, is no summary openforge can keep.
 */
export function summaryOf(replacement: ReadonlyArray<Message>): string | undefined {
  for (const message of replacement) {
    if (message.role !== "user") continue
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    if (!text.startsWith(PREFIX)) continue
    const summary = text.slice(PREFIX.length)
    if (summary.trim()) return summary
  }
  return undefined
}

/** What went wrong with CPP's summary: its request's failure, or a `timeout` or `unreadable` answer. */
export type Failure = AIError | "timeout" | "unreadable"

/** Why CPP couldn't write it, short: the record's `fallback`, after "CLIProxyPacer couldn't: ". */
export function fallback(failure: Failure | unknown) {
  if (failure === "timeout") return "no answer in 4 minutes"
  if (failure === "unreadable") return "no readable summary"
  if (!(failure instanceof AIError)) return "it failed"
  const reason = failure.reason
  if (reason._tag === "InvalidProviderOutput") return "no readable summary"
  if (reason.http?.status !== undefined && (reason.http.status < 200 || reason.http.status >= 300))
    return `it answered ${reason.http.status}`
  if (reason._tag === "Transport") return "it could not be reached"
  return "it failed"
}

/**
 * HTTP middleware around `inner` that hands `seen` the answer's `X-Pacer-Compaction`, read from the provider's own
 * answer, not one a hook rewrote; the request and its body stay as they are.
 */
export function capture(inner: HttpMiddleware | undefined, seen: (value: string | undefined) => void): HttpMiddleware {
  return (request, handler) => {
    const read: typeof handler = (sent) =>
      handler(sent).pipe(Effect.tap((response) => Effect.sync(() => seen(response.headers["x-pacer-compaction"]))))
    return inner ? inner(request, read) : read(request)
  }
}

// ------------------------------------------------------------------ warm or cold

/** What the compaction is, as far as warmth goes. */
export interface Asked {
  readonly reason: "auto" | "overflow" | "manual" | "move" | "cold"
  /** CPP's picks, as its 409 (or a `compact` notice) names them. */
  readonly models?: ReadonlyArray<string>
}

/**
 * How warm the chat's cache is at this compaction, from what openforge knows then: a cold ask is cold; a move is warm
 * unless its 409 says the account ran out, which its `models` tell (CLIENT-GUIDE 4.2: while the chat's account has not
 * run out and the chat is warm there, they start with the chat's own model, `model`; otherwise they are
 * `routing.compaction_models` alone); anything else (automatic, overflow, `/compact`, a `compact` notice) is read from
 * the chat's view ({@link viewWarm}).
 */
export function warmth(asked: Asked, model: string): boolean | "view" {
  if (asked.reason === "cold") return false
  if (asked.reason !== "move") return "view"
  const first = asked.models?.[0]
  return first === undefined || first.toLowerCase() === model.toLowerCase()
}

/** A chat's view as far as warmth goes, on this clock. */
export interface Warmth {
  readonly warm: boolean
  readonly warmUntil?: number
}

/** Warm by the chat's view: CPP says warm and its warm-until is not past. No view counts as warm. */
export function viewWarm(view: Warmth | undefined, now: number) {
  if (view === undefined) return true
  return view.warm && (view.warmUntil === undefined || view.warmUntil > now)
}

/**
 * THE INTERIM WARM/COLD RULE (the lead's recommendation of 2026-11-07, for the spec's open question). A chat whose
 * steps go to CPP in the Messages format (Claude) gets openforge's own summary while its cache is warm: CPP's summary
 * through `/responses/compact` does not read a Messages chat's conversation cache, which its next step would then
 * write again (step 0's measurement, `run/evidence/cpp-summaries/measure/`). The same chat cold, and every other chat
 * warm or cold, gets CPP's. Delete this function and its one use in {@link decide} once CPP writes summaries for
 * Messages requests without losing the cache, or the owner chooses CPP's anyway.
 */
export function openforgeWhileWarm(chat: { readonly messages: boolean; readonly warm: boolean }) {
  return chat.messages && chat.warm
}

/** Who writes a summary of a chat on CPP. `fallback` says why CPP couldn't, when it was meant to. */
export type Decision = { readonly by: "cliproxypacer" } | { readonly by: "openforge"; readonly fallback?: string }

export const ROUTE = "it writes no summaries on this model's route"

/**
 * Who writes, in this order: the writer ({@link writerFor}: `client` is openforge, `server` or unset CPP); the interim
 * rule; then only where CPP writes for the model's route with `server`.
 */
export function decide(input: {
  /** Who writes by the settings ({@link writerFor}); undefined while unset. */
  readonly writer: "server" | "client" | undefined
  /** CPP writes on the writing model's route with `server` (`PacerModels.writes`). */
  readonly writes: boolean
  /** The chat's steps go to CPP in the Messages format. */
  readonly messages: boolean
  readonly warm: boolean
}): Decision {
  if (input.writer === "client") return { by: "openforge" }
  if (openforgeWhileWarm(input)) return { by: "openforge" }
  if (!input.writes) return { by: "openforge", fallback: ROUTE }
  return { by: "cliproxypacer" }
}

/**
 * Who writes by the settings (spec cliproxypacer-server-summaries, section 2): the key level, as Settings shows it
 * (`compaction.writer` of the key, else the server's, else the default), so that a choice there reaches every chat,
 * those with the own `server` openforge set too; and a chat's own `client`, which someone else set (CPP's dashboard).
 * Not the chat's effective value: its own `server` would outvote the key's `client`.
 */
export function writerFor(settings: {
  /** The key level's `compaction.writer`; undefined while unset. */
  readonly key: "server" | "client" | undefined
  /** The chat's own; undefined while it holds none. */
  readonly own: "server" | "client" | undefined
}): "server" | "client" {
  return settings.key === "client" || settings.own === "client" ? "client" : "server"
}

// ------------------------------------------------------------------ the service

export interface PlanInput {
  readonly sessionID: SessionID
  readonly parentID?: SessionID
  /** CPP's ID of the model that would write it: one of CPP's picks, else the chat's own. */
  readonly model: string
  /** The chat's steps go to CPP in the Messages format (Claude), not Responses. */
  readonly messages: boolean
  /** Known from the compaction ({@link warmth}), else read from the chat's view. */
  readonly warm: boolean | "view"
}

export interface Interface {
  /**
   * Who writes the summary, asking CPP only while the connection is on (`PacerStatus`). Unreachable, openforge writes,
   * saying so ({@link UNREACHABLE}); without a pacer, or not set up, undefined: openforge writes, naming no writer, as
   * for a chat on any provider. On, it reads the chat's view now (its own writer, its effective one, its warmth), the
   * key level's listing ({@link writerFor}), and the catalog for the model's routes. When CPP is to write and the
   * chat's effective writer isn't `server`, sets the chat's own `server` first (one `PATCH`): an unset writer answers
   * Claude with a capsule only CPP opens. Never fails: openforge writes, saying why, when CPP can't be asked.
   */
  readonly plan: (input: PlanInput) => Effect.Effect<Decision | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerSummaries") {}

/** Why CPP couldn't: the connection is unreachable, or a read before asking failed. */
export const UNREACHABLE = "unreachable"
export const UNSET = "the chat's writer could not be set"

const decodeView = Schema.decodeUnknownOption(PacerWire.View)

/** A `compaction.writer` value; undefined for unset or anything else. */
function writerOf(value: unknown): "server" | "client" | undefined {
  return value === "server" || value === "client" ? value : undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* PacerHttp.Service
    const endpoints = yield* PacerEndpoint.Service
    const models = yield* PacerModels.Service
    const status = yield* PacerStatus.Service

    /** The chat's view, or undefined when CPP knows nothing of it. */
    const view = Effect.fnUntraced(function* (path: string, endpoint: PacerEndpoint.Endpoint) {
      const answer = yield* http.get(path, Schema.Unknown, { endpoint }).pipe(
        Effect.map(Option.some),
        Effect.catchTag("PacerHttp.NotFound", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(answer)) return undefined
      const decoded = decodeView(answer.value.body)
      if (Option.isNone(decoded)) return yield* new PacerHttp.Unexpected({ reason: "the chat's view does not decode" })
      const offset = answer.value.offset
      return { view: decoded.value, offset: offset ? Math.round((offset.low + offset.high) / 2) : 0 }
    })

    const plan = Effect.fn("PacerSummaries.plan")(function* (input: PlanInput) {
      const { state } = yield* status.get()
      if (state === "unreachable") return { by: "openforge", fallback: UNREACHABLE } satisfies Decision
      if (state !== "on") return undefined
      const endpoint = yield* endpoints.get()
      if (!endpoint) return { by: "openforge", fallback: UNREACHABLE } satisfies Decision
      const path = `/pacer/v1/sessions/${encodeURIComponent(PacerSessionID.make(input.sessionID))}`
      const read = yield* Effect.result(
        Effect.gen(function* () {
          // Undefined for a chat CPP knows nothing of yet: it has no writer of its own.
          const held = yield* view(path, endpoint)
          const listing = yield* http.get("/pacer/v1/settings", PacerWire.Settings, { endpoint })
          const key = PacerWire.settings(listing.body).summaryWriter
          return {
            writer: writerFor({
              key: key === undefined ? undefined : PacerWire.writers[key],
              own: writerOf(held?.view.settings?.[PacerWire.settingNames.summaryWriter]),
            }),
            effective: writerOf(held?.view.effective?.compaction_writer),
            provider: held?.view.provider ?? undefined,
            warmth: held
              ? { warm: held.view.warm === true, warmUntil: PacerWire.local(held.view.warm_until, held.offset) }
              : undefined,
          }
        }),
      )
      if (Result.isFailure(read)) return { by: "openforge", fallback: UNREACHABLE } satisfies Decision
      const chat = read.success
      const now = yield* Clock.currentTimeMillis
      const catalog = yield* models.get()
      const wanted = input.model.toLowerCase()
      const model = catalog?.models.find((item) => item.id === input.model || item.id.toLowerCase() === wanted)
      const decision = decide({
        writer: chat.writer,
        writes: PacerModels.writes(model, chat.provider),
        messages: input.messages,
        warm: input.warm === "view" ? viewWarm(chat.warmth, now) : input.warm,
      })
      if (decision.by !== "cliproxypacer" || chat.effective === "server") return decision
      const claimed = yield* Effect.result(
        http.patch(path, { [PacerWire.settingNames.summaryWriter]: PacerWire.writers.cliproxypacer }, Schema.Unknown, {
          endpoint,
        }),
      )
      return Result.isFailure(claimed) ? ({ by: "openforge", fallback: UNSET } satisfies Decision) : decision
    })

    return Service.of({ plan: (input) => plan(input) })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [PacerEndpoint.node, PacerHttp.node, PacerModels.node, PacerStatus.node],
})
