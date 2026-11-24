import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.goals,
  Effect.fn("cli.cpp.goals")(function* (input) {
    yield* read(`projects/${encodeURIComponent(input.project)}/goals`, { all: input.all }, input.json)
  }),
)
