// The compiled binary's entry. `sandbox-exec` starts every sandboxed shell command, so it runs before the rest of the
// CLI is even loaded; everything else goes on to the CLI.
import "./sandbox-exec"

await import("./index")
