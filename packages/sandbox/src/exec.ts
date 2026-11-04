// `openforge sandbox-exec <policy> -- <command> [arguments…]`: confines itself, then becomes the command. It imports
// only what that needs, because it runs before every sandboxed command starts.
import { writeSync } from "node:fs"
import { defaultSignals } from "#native"
import { Landlock } from "./landlock.js"

const SIGPIPE = 13
const SIGXFSZ = 25

export function main(args: readonly string[]): never {
  const [encoded, separator, ...argv] = args
  if (encoded === undefined || separator !== "--" || argv.length === 0)
    return exit(2, "usage: sandbox-exec <policy> -- <command> [arguments…]")
  const policy = attempt(() => Landlock.decode(encoded))
  if (policy instanceof Error) return exit(125, `cannot read the policy: ${policy.message}`)
  const confined = attempt(() => Landlock.confine(policy))
  if (confined instanceof Error) return exit(125, `cannot sandbox the command: ${confined.message}`)
  const command = argv[0]
  const file = command.includes("/") ? command : Bun.which(command)
  if (!file) return exit(127, `${command}: command not found`)
  defaultSignals([SIGPIPE, SIGXFSZ])
  const failed = attempt(() => process.execve!(file, argv, process.env))
  const code = failed instanceof Error && "code" in failed && failed.code === "ENOENT" ? 127 : 126
  return exit(code, `${command}: ${failed instanceof Error ? failed.message : "cannot run"}`)
}

function exit(code: number, message: string): never {
  writeSync(2, `sandbox-exec: ${message}\n`)
  return process.exit(code)
}

function attempt<T>(fn: () => T) {
  try {
    return fn()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
