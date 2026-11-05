// `openforge sandbox-exec <policy> -- <command> [arguments…]`: confines itself, then becomes the command. It imports
// only what that needs, because it runs before every sandboxed command starts.
import { writeSync } from "node:fs"
import { defaultSignals } from "#native"
import { Landlock } from "./landlock.js"

const SIGPIPE = 13
const SIGXFSZ = 25
// The exit codes of `env` and the shell: this command failed, the command can't run, the command wasn't found.
const USAGE = 2
const NOT_SANDBOXED = 125
const CANNOT_RUN = 126
const NOT_FOUND = 127

export function main(args: readonly string[]): never {
  const [encoded, separator, ...argv] = args
  if (encoded === undefined || separator !== "--" || argv.length === 0)
    return exit(USAGE, "usage: sandbox-exec <policy> -- <command> [arguments…]")
  const policy = orExit("cannot read the policy", () => Landlock.decode(encoded))
  orExit("cannot sandbox the command", () => Landlock.confine(policy))
  const command = argv[0]
  const file = command.includes("/") ? command : Bun.which(command)
  if (!file) return exit(NOT_FOUND, `${command}: command not found`)
  defaultSignals([SIGPIPE, SIGXFSZ])
  try {
    return process.execve!(file, argv, process.env)
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
    return exit(missing ? NOT_FOUND : CANNOT_RUN, `${command}: ${message(error)}`)
  }
}

/** What `step` returns; when it throws, the command doesn't run. */
function orExit<T>(what: string, step: () => T): T {
  try {
    return step()
  } catch (error) {
    return exit(NOT_SANDBOXED, `${what}: ${message(error)}`)
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function exit(code: number, text: string): never {
  writeSync(2, `sandbox-exec: ${text}\n`)
  return process.exit(code)
}
