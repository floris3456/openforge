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
