// Starts a service with Service.ensure, then replaces this process with `sleep`, as a TUI that restarts on a new
// release replaces itself: the new image never reaps a child the old one started.
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { writeFile } from "node:fs/promises"
import { Service } from "../../src/effect/service"

const [registration, ...command] = process.argv.slice(2)
if (registration === undefined || command.length === 0) throw new Error("Missing ensure-and-exec arguments")
await Effect.runPromise(
  Service.ensure({ file: registration, version: "test", command }).pipe(Effect.provide(NodeFileSystem.layer)),
)
await writeFile(registration + ".ensured", String(process.pid))
process.execve?.("/bin/sleep", ["sleep", "60"], process.env)
