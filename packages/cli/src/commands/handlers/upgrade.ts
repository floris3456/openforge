import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Updater } from "../../upgrade/updater"
import { handlePromptErrors } from "../../ui/prompt"

export default Runtime.handler(
  Commands.commands.upgrade,
  Effect.fn("cli.upgrade")(function* (input) {
    intro("Upgrade")
    const updater = yield* Updater.Service
    const progress = spinner()
    let spinning = false
    const stop = (message: string, code?: number) => {
      if (!spinning) return
      spinning = false
      progress.stop(message, code)
    }
    const step = (message: string) => {
      stop("Done")
      spinning = true
      progress.start(message)
    }
    const outcome = yield* updater
      .upgrade({
        target: Option.getOrUndefined(input.target),
        restoreDatabase: input.restoreDatabase,
        notify: (state) => {
          if (state.type === "installing") return step(`Installing openforge ${state.version}`)
          if (state.type === "ready") {
            stop(`openforge ${state.version} installed`)
            return log.info(`openforge ${state.version} is ready; switches when no chat is running`)
          }
          if (state.type === "switching") return step(`Switching to openforge ${state.version}`)
          if (state.type === "switched") return stop(`openforge ${state.version} is running`)
          if (state.type === "failed") return stop("Failed", 1)
        },
      })
      .pipe(Effect.ensuring(Effect.sync(() => stop("Stopped", 1))))
    if (outcome.type === "unavailable") return yield* Effect.fail(new Error(outcome.message))
    if (outcome.type === "switched" && input.restoreDatabase)
      log.info(
        `The database used until now is kept beside openforge ${outcome.from}; to get it back: openforge upgrade ${outcome.from} --restore-database`,
      )
    if (outcome.type === "current")
      log.info(
        Option.isSome(input.target)
          ? `openforge ${outcome.version} is already in use`
          : `openforge ${outcome.version} is up to date`,
      )
    outro("Done")
  }, handlePromptErrors),
)
