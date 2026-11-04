import { RunnerMain } from "@opencode/runner/main"
import { OPENCODE_VERSION } from "./version"

/** `openforge runner <directory>`: this release's tool runner, which the service starts when a command needs one. */
export function run(args: ReadonlyArray<string>) {
  const directory = args[0]
  if (!directory) {
    process.stderr.write("usage: openforge runner <directory>\n")
    return Promise.resolve(2)
  }
  return RunnerMain.main({ directory, version: OPENCODE_VERSION })
}
