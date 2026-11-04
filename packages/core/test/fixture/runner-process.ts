// The tool runner as its own process, as `openforge runner <directory>` runs it, with the short grace of
// `GRACE` in ./runner.ts (not imported, so this process stays a bare runner).
import { RunnerMain } from "@opencode/runner/main"

const directory = process.argv[2]
if (!directory) throw new Error("usage: runner-process.ts <directory>")
process.exit(await RunnerMain.main({ directory, version: "test", grace: 200 }))
