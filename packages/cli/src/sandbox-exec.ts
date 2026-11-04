// The hidden command `openforge sandbox-exec <policy> -- <command> [arguments…]`, which starts every sandboxed shell
// command on Linux: it confines itself and becomes the command. It is handled before the CLI loads, and imports
// nothing heavy, so a command doesn't wait for the rest of openforge to start.
import { main } from "@opencode/sandbox/exec"

if (process.argv[2] === "sandbox-exec") main(process.argv.slice(3))
