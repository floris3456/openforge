import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.projects,
  Effect.fn("cli.cpp.projects")(function* (input) {
    yield* read("projects", { all: input.all, cursor: Option.getOrUndefined(input.cursor) }, input.json)
  }),
)
