import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.recall,
  Effect.fn("cli.cpp.recall")(function* (input) {
    yield* read(
      `projects/${encodeURIComponent(input.project)}/recall`,
      {
        q: input.query.join(" "),
        scope: Option.getOrUndefined(input.scope),
        kind: input.kind.length ? input.kind.join(",") : undefined,
        limit: Option.getOrUndefined(input.limit),
        cursor: Option.getOrUndefined(input.cursor),
      },
      input.json,
    )
  }),
)
