import { confirm, intro, log, outro, spinner } from "@clack/prompts"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schedule } from "effect"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { ReleaseLayout } from "../../upgrade/layout"
import { Product } from "@opencode/schema/product"
import { handlePromptErrors, prompt, requireInteractive } from "../../ui/prompt"
import { errorMessage } from "../../util/error"

export default Runtime.handler(
  Commands.commands.uninstall,
  Effect.fn("cli.uninstall")(function* (input) {
    intro(`Uninstall ${Product.name}`)
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    // Data, config, and state hold sessions, credentials, settings, and prompt history; uninstall only removes the cache
    // and the installed binaries. The database copies in the release folders stay with the data.
    // All channels share the cache. Stop background services before deleting it.
    // Read registrations directly: ServiceConfig.options() can migrate files even during a dry run.
    const services = (yield* fs.exists(global.state))
      ? (yield* fs.readDirectory(global.state)).filter((name) => /^service(?:-.*)?\.json$/.test(name))
      : []
    const layout = ReleaseLayout.at(global.data)
    const binaries = (yield* ReleaseLayout.installed(layout)).map((version) => ReleaseLayout.binary(layout, version))
    const command = path.join(global.home, ".local", "bin", Product.binary)
    const commandLink = (yield* fs.readLink(command).pipe(Effect.option)).pipe(
      Option.filter((target) => target === path.join(layout.current, Product.binary)),
    )
    const current = yield* fs.readLink(layout.current).pipe(Effect.option)

    log.message(`The following global files will be removed (shared by ${Product.name} versions and channels):`)
    if (yield* fs.exists(global.cache)) log.info(`  Cache: ${global.cache}`)
    services.forEach((name) =>
      log.info(`  Stop background service and persistent terminals: ${path.join(global.state, name)}`),
    )
    if (Option.isSome(commandLink)) log.info(`  Command: ${command}`)
    if (Option.isSome(current)) log.info(`  Release link: ${layout.current}`)
    binaries.forEach((file) => log.info(`  Binary: ${file}`))
    if (!binaries.length)
      log.warn(`No ${Product.name} release is installed in ${layout.releases}. Remove the binary manually.`)

    if (input.dryRun) {
      log.warn("Dry run - no changes made")
      outro("Done")
      return
    }
    if (!input.force) {
      yield* requireInteractive("Use --force to uninstall without an interactive terminal, or --dry-run to preview.")
      const accepted = yield* prompt(() =>
        confirm({ message: "Are you sure you want to uninstall?", initialValue: false }),
      )
      if (!accepted) {
        outro("Cancelled")
        return
      }
    }

    const progress = spinner()
    if (services.length) {
      progress.start("Stopping background services...")
      yield* Effect.forEach(services, (name) =>
        Effect.gen(function* () {
          const options = { file: path.join(global.state, name) }
          yield* ServerConnection.shutdownPersistentPty(options).pipe(Effect.ignore)
          yield* Service.stop(options)
        }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Background services stopped"))),
        Effect.tapCause(() => Effect.sync(() => progress.stop("Failed to stop background services", 1))),
      )
    }

    const errors: string[] = []
    progress.start("Removing Cache...")
    yield* fs.remove(global.cache, { recursive: true, force: true }).pipe(
      // Windows reports a terminated service as gone before it releases its file handles,
      // so the first removal can race that teardown.
      Effect.retry({
        while: (error) => process.platform === "win32" && error.reason._tag === "Busy",
        schedule: Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(40)]),
      }),
      Effect.tap(() => Effect.sync(() => progress.stop("Removed Cache"))),
      Effect.catch((error) =>
        Effect.sync(() => {
          progress.stop("Failed to remove Cache", 1)
          errors.push(`Cache: ${errorMessage(error)}`)
        }),
      ),
    )
    // The running binary is one of these; removing a running file is safe on the platforms openforge ships for.
    yield* Effect.forEach(
      [
        ...(Option.isSome(commandLink) ? [command] : []),
        ...(Option.isSome(current) ? [layout.current] : []),
        ...binaries,
      ],
      (file) =>
        fs
          .remove(file, { force: true })
          .pipe(Effect.catch((error) => Effect.sync(() => errors.push(`${file}: ${errorMessage(error)}`)))),
    )
    if (errors.length) yield* Effect.fail(new Error(errors.join("\n")))
    outro("Done")
  }, handlePromptErrors),
)
