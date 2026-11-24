import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { read } from "./inspect"

export default Runtime.handler(
  Commands.commands.cpp.commands.read,
  Effect.fn("cli.cpp.read")(function* (input) {
    yield* read("items", { ids: input.ids.join(",") }, input.json)
  }),
)
