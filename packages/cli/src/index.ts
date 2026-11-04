#!/usr/bin/env bun

// First, so `sandbox-exec` runs before the other imports load.
import "./sandbox-exec"

// The tool runner starts before the rest of the CLI loads: it holds commands for as long as they run, so it stays small.
if (process.argv[2] === "runner") process.exit(await (await import("./runner")).run(process.argv.slice(3)))
await import("./cli")
