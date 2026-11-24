import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.review,
  Effect.fn("cli.cpp.review")(function* (input) {
    yield* read(`tasks/${encodeURIComponent(input.task)}/review`, {}, input.json)
  }),
)
