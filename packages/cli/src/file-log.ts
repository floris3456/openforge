export * as FileLog from "./file-log"

import { Layer, Logger, References } from "effect"
import { Logging } from "@opencode/util/observability/logging"

// openforge (workspace task 92h1sva2hb2j): an agent's shell is sandboxed and may not write openforge's data folder, which
// holds the file log, so a command run there could not even start. A command that only asks the running service runs
// on without the file log when it can't open it; the service and the rest keep failing at start, loudly.

/** The commands that only ask the running service, each once, unless `--standalone` gives them a server of their own. */
const CLIENTS = new Set([
  "api",
  "auth",
  "cpp",
  "debug",
  "mcp",
  "models",
  "pair",
  "plugin",
  "reload",
  "service",
  "session",
  "stats",
])

/** Built-in flags that print instead of running a command. */
const PRINTS = new Set(["--help", "-h", "--version", "-v"])

/** Whether the run of `argv` (the arguments after the binary) may go on without the file log. */
export function optional(argv: readonly string[]) {
  if (argv.some((arg) => PRINTS.has(arg) || arg.startsWith("--completions"))) return true
  if (argv.some((arg) => arg === "--standalone" || arg.startsWith("--standalone="))) return false
  const command = argv.find((arg) => !arg.startsWith("-"))
  return command !== undefined && CLIENTS.has(command)
}

/**
 * `observability`, or for a run that may go without the file log ({@link optional}), when it fails to build: the
 * loggers that open nothing (`--print-logs` still prints), nothing written and nothing said about it.
 */
export function layer<E, R>(observability: Layer.Layer<never, E, R>, argv: readonly string[]) {
  if (!optional(argv)) return observability
  return observability.pipe(
    Layer.catchCause(() =>
      Logger.layer(Logging.loggers().filter(Logger.isLogger), { mergeWithExisting: false }).pipe(
        Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
      ),
    ),
  )
}
