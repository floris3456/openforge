// The runner as its own process, as `openforge runner <directory>` runs it.
import { RunnerMain } from "../../src/main.js"

const directory = process.argv[2]
if (!directory) throw new Error("usage: serve.ts <directory> [version] [killAfter]")
process.exit(
  await RunnerMain.main({
    directory,
    version: process.argv[3] ?? "test",
    killAfter: process.argv[4] ? Number(process.argv[4]) : undefined,
  }),
)
