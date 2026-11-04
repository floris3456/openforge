// Stands in for `openforge sandbox-exec` from source, for tests that don't use a compiled openforge.
import { main } from "../../src/exec.js"

if (process.argv[2] !== "sandbox-exec") throw new Error("usage: sandbox-exec.ts sandbox-exec <policy> -- <command…>")
main(process.argv.slice(3))
