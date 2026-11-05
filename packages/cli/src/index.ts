#!/usr/bin/env bun

// `sandbox-exec` starts every sandboxed shell command, so it runs before anything else loads: its static import is the
// only one here, and the runner and the CLI are imported once it has passed.
import "./sandbox-exec"

// The tool runner starts before the rest of the CLI loads: it holds commands for as long as they run, so it stays small.
if (process.argv[2] === "runner") {
  const { run } = await import("./runner")
  process.exit(await run(process.argv.slice(3)))
}
await import("./cli")
