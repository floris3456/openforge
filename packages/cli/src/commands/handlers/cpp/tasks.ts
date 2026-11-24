import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.tasks,
  Effect.fn("cli.cpp.tasks")(function* (input) {
    yield* read(
      `projects/${encodeURIComponent(input.project)}/tasks`,
      {
        state: Option.getOrUndefined(input.state),
        query: Option.getOrUndefined(input.query),
        limit: Option.getOrUndefined(input.limit),
        cursor: Option.getOrUndefined(input.cursor),
      },
      input.json,
    )
  }),
)
