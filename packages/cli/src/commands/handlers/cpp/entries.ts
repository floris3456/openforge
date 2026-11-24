import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.entries,
  Effect.fn("cli.cpp.entries")(function* (input) {
    yield* read(
      `projects/${encodeURIComponent(input.project)}/entries`,
      {
        role: Option.getOrUndefined(input.role),
        task: Option.getOrUndefined(input.task),
        kind: Option.getOrUndefined(input.kind),
        state: Option.getOrUndefined(input.state),
        limit: Option.getOrUndefined(input.limit),
        cursor: Option.getOrUndefined(input.cursor),
      },
      input.json,
    )
  }),
)
