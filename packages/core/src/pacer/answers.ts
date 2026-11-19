export * as PacerAnswers from "./answers.js"

import { AIError } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Pacer } from "@opencode/schema/pacer"
import { Option, Schema } from "effect"

/** The provider these answers come from; `PacerEndpoint.id` as a plain string, so this module stays free of services. */
const provider = "cliproxypacer"

const CompactRequired = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.Literal("pacer_compact_required"),
      reason: Schema.optional(Schema.Unknown),
      models: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
)
const decodeCompactRequired = Schema.decodeUnknownOption(CompactRequired)

/**
 * CPP asks to compact a chat first: `move`, before it moves the chat to another account; `cold`, before the next step
 * of a chat whose prompt cache went cold and that is large. `models` are its picks for the summary, first first.
 */
export interface CompactAsk {
  readonly reason: "move" | "cold"
  readonly models: ReadonlyArray<Model.Ref>
}

/**
 * CPP's ask to compact first (its CLIENT-GUIDE, "Compaction", "The three asks"): a 409 whose body's error type is
 * `pacer_compact_required`, on a request to the CLIProxyPacer provider. `reason: "cold"` is a cold ask; every other
 * reason, or none, is a move, as the guide says. Its `writer` is not read: openforge writes every summary itself, which
 * the guide allows for both. The answer's models are CPP's own IDs, so each is a model of the chat's provider.
 */
export function compactAsk(model: Model.Ref, failure: unknown): CompactAsk | undefined {
  if (model.providerID !== provider || !(failure instanceof AIError)) return undefined
  if (failure.reason.http?.status !== 409 || failure.reason.body === undefined) return undefined
  return Option.match(decodeCompactRequired(failure.reason.body), {
    onNone: () => undefined,
    onSome: (answer) => ({
      reason: answer.error.reason === "cold" ? "cold" : "move",
      models: (answer.error.models ?? []).map((id) =>
        Model.Ref.make({ id: Model.ID.make(id), providerID: model.providerID }),
      ),
    }),
  })
}

// CPP's answer when the provider refused the prompt itself: `code: "prompt_refused"`; before it had the code, only the
// message of Antigravity's said so.
const PromptRefused = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Union([
      Schema.Struct({ code: Schema.Literal("prompt_refused") }),
      Schema.Struct({
        message: Schema.String.check(Schema.isPattern(/^Antigravity refused this request without using quota/)),
      }),
    ]),
  }),
)
const decodePromptRefused = Schema.decodeUnknownOption(PromptRefused)

/**
 * Whether a request to the CLIProxyPacer provider was answered with CPP's 400 for a prompt the provider refused itself
 * (Antigravity's fake `429 RESOURCE_EXHAUSTED` for a system instruction it takes for another coding tool's): a step
 * answered so is a cold point (`SessionPromptStart.refused`).
 */
export function refused(model: Model.Ref, failure: unknown) {
  if (model.providerID !== provider || !(failure instanceof AIError)) return false
  if (failure.reason.http?.status !== 400 || failure.reason.body === undefined) return false
  return Option.isSome(decodePromptRefused(failure.reason.body))
}

/**
 * A 502 on a request to the CLIProxyPacer provider. CPP's own comes from a pair's standby that retried its forward to
 * the active every 250 ms for 10 s (`pair_forward.rs`, `route`): "CPP is down"'s answer with the status changed, so it
 * says `Retry-After: 30`, and nothing ran upstream. A standby that cannot reach the active stops its Cloudflare
 * connector (`tunnel.rs`, `wanted`: at once, or when armed once the witness refuses it or 15 s on, `failover.rs`,
 * `KEEP_CONNECTOR`), and Cloudflare sends the next request to the other one at once, so only a second 502 in a row
 * waits for it. Cloudflare's own 502, while no connector is up, says no `Retry-After`.
 */
export function badGateway(model: Model.Ref, failure: AIError) {
  return model.providerID === provider && failure.reason.http?.status === 502
}

/**
 * How long a step keeps retrying through a CPP outage, from the first failure of the run: the same 30 minutes as
 * OpenCodePlus (`cliproxyapi/src/outage.ts`, `OUTAGE_RETRY_FOR`), long enough for a CPP restart.
 */
export const OUTAGE_RETRY_FOR = 30 * 60_000

// `pair_forward.rs`'s `cpp_down`: `code: "cpp_down"` on OpenAI's routes; on Messages only its message says so.
const CppDown = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Union([
      Schema.Struct({ code: Schema.Literal("cpp_down") }),
      Schema.Struct({ message: Schema.String.check(Schema.isPattern(/^CPP is down/)) }),
    ]),
  }),
)
const decodeCppDown = Schema.decodeUnknownOption(CppDown)

/**
 * Whether a failure of a request to the CLIProxyPacer provider says that neither CPP nor the tunnel in front of it can
 * serve: a transport failure other than a timeout, a 502 or 504, or CPP's "CPP is down" 503 (its CLIENT-GUIDE,
 * "Answers a client gets back"). Not CPP's other 503s (`pacer_transient_wait`, `auth_unavailable`), nor a 429: CPP is
 * there and says how long to wait, or not to loop. A timed-out attempt keeps its own cap (`ModelRetry`), and a
 * transport failure while reading cut a stream CPP had answered: the next request says whether CPP is there.
 */
export function outage(model: Model.Ref, failure: AIError) {
  if (model.providerID !== provider) return false
  const reason = failure.reason
  if (reason._tag === "Transport") return reason.code !== "Timeout" && reason.operation !== "read"
  const status = reason.http?.status
  if (status === 502 || status === 504) return true
  return status === 503 && reason.body !== undefined && Option.isSome(decodeCppDown(reason.body))
}

/**
 * Whether a request to the CLIProxyPacer provider was refused for want of a free login: CPP's `503 auth_unavailable`
 * (every account that could serve the model rests) or `429 model_cooldown` (every one is at its quota), both with a
 * `Retry-After` that is the soonest moment one is due back (its CLIENT-GUIDE, "Answers a client gets back"). An account
 * can come back sooner, which CPP's `ready` notice says (`Pacer.Event.LoginsReady`). Not `auth_not_found` (no account
 * serves the model) nor the terminal `upstream_authentication_required`, which carry no wait.
 */
export function noLogin(model: Model.Ref, failure: AIError) {
  if (model.providerID !== provider) return false
  return Pacer.noFreeLogin(failure.reason.http?.status, failure.reason.body ?? failure.reason.message)
}

/**
 * Whether CPP's `ready` notice may free a login for `model`: it names the model (without a variant suffix, as CPP keeps
 * its cooldowns), or names no models (any model of its providers).
 */
export function readyFor(model: Model.Ref, ready: { readonly models: ReadonlyArray<string> }) {
  if (model.providerID !== provider) return false
  return ready.models.length === 0 || ready.models.includes(baseModel(model.id))
}

const baseModel = (id: string) => id.replace(/\([^()]*\)$/, "")
