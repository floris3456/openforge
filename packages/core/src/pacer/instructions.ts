export * as PacerInstructions from "./instructions.js"

import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import type { PacerTools } from "./tools.js"

// CLIProxyPacer's instructions for agents (workspace spec `docs/specs/codemode-pinning.md`, item 3): its tool list
// carries them, written for the tools it holds and for a client that runs Code Mode. A chat keeps the text it has while
// warm; another one arrives as an update and becomes its baseline at its next cold point, as its other instructions do.
// The source reads what the chat holds, never CLIProxyPacer: the list's own read decides when they change.

const Value = Schema.Struct({ text: Schema.String, version: Schema.String })

/**
 * The chat's instructions as one source, or none while the chat holds no list. A list that carries no instructions
 * renders nothing; one that loses them tells the model they no longer apply.
 */
export const make = (list: PacerTools.List | undefined): Instructions.List => {
  if (list === undefined) return Instructions.empty
  return Instructions.make({
    key: Instructions.Key.make("pacer/instructions"),
    codec: Schema.toCodecJson(Value),
    read: Effect.succeed(list.instructions ?? Instructions.removed),
    render: {
      initial: (value) => value.text,
      changed: (_previous, value) =>
        `CLIProxyPacer's instructions have changed; these replace the earlier ones:\n\n${value.text}`,
      removed: () => "CLIProxyPacer's instructions no longer apply.",
    },
  })
}
