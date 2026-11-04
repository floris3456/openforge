// Stands in for `openforge sandbox-exec` from source: `bun sandbox-exec.ts sandbox-exec <policy> -- <command…>`.
import { main } from "@opencode/sandbox/exec"

if (process.argv[2] !== "sandbox-exec") throw new Error("usage: sandbox-exec.ts sandbox-exec <policy> -- <command…>")
main(process.argv.slice(3))
