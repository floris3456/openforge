export * as PacerAnswers from "./answers.js"

import { AIError } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"

/** The provider these answers come from; `PacerEndpoint.id` as a plain string, so this module stays free of services. */
const provider = "cliproxypacer"

const CompactRequired = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.Literal("pacer_compact_required"),
      models: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
)
const decodeCompactRequired = Schema.decodeUnknownOption(CompactRequired)

/** CPP asks to compact a chat it must move to another account; `models` are its picks for the summary, first first. */
export interface MoveAsk {
  readonly models: ReadonlyArray<Model.Ref>
}

/**
 * CPP's ask to compact before it moves the chat (its CLIENT-GUIDE, "Compaction"): a 409 whose body's error type is
 * `pacer_compact_required`, on a request to the CLIProxyPacer provider. Any `reason` is a move, as the guide says, and
 * openforge announces only `auto`. The answer's models are CPP's own IDs, so each is a model of the chat's provider.
 */
export function moveAsk(model: Model.Ref, failure: unknown): MoveAsk | undefined {
  if (model.providerID !== provider || !(failure instanceof AIError)) return undefined
  if (failure.reason.http?.status !== 409 || failure.reason.body === undefined) return undefined
  return Option.match(decodeCompactRequired(failure.reason.body), {
    onNone: () => undefined,
    onSome: (answer) => ({
      models: (answer.error.models ?? []).map((id) =>
        Model.Ref.make({ id: Model.ID.make(id), providerID: model.providerID }),
      ),
    }),
  })
}

/**
 * A 502 on a request to the CLIProxyPacer provider. CPP's own comes from a pair's standby that retried its forward to
 * the active every 250 ms for 10 s (`pair_forward.rs`, `route`): "CPP is down"'s answer with the status changed, so it
 * says `Retry-After: 30`, and nothing ran upstream. A standby that cannot reach the active stops its Cloudflare
 * connector (`tunnel.rs`, `wanted`; an armed one 15 s on, `failover.rs`, `KEEP_CONNECTOR`), and Cloudflare sends the
 * next request to the other one at once, so only a second 502 in a row waits for it. Cloudflare's own 502, while no
 * connector is up, says no `Retry-After`.
 */
export function badGateway(model: Model.Ref, failure: AIError) {
  return model.providerID === provider && failure.reason.http?.status === 502
}
