// A stand-in for an openforge release binary. The shell script written by `fakeBinary` sets FAKE_VERSION and
// FAKE_SERVE; `--version` prints the version and `serve --service` registers a small service that answers the
// requests a release switch makes.
//   FAKE_SERVE=ok             answers with its version
//   FAKE_SERVE=crash          records its migration, then exits 3
//   FAKE_SERVE=wrong-version  answers with version 9.9.9
//   FAKE_PRINT                what --version prints instead of the version
// The service records `m-<version>` in the database's migration journal, as a release migrating it would.
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"

const version = process.env.FAKE_VERSION ?? "0.0.0"
const args = process.argv.slice(2)

if (args[0] === "--version") {
  console.log(`openforge v${process.env.FAKE_PRINT ?? version}`)
  process.exit(0)
}

if (args[0] !== "serve" || args[1] !== "--service") {
  console.error(`fake openforge ${version}: unexpected arguments ${args.join(" ")}`)
  process.exit(2)
}

const database = process.env.FAKE_DATABASE
if (database) {
  using db = new Database(database)
  db.run("CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  db.run("INSERT OR IGNORE INTO migration (id, time_completed) VALUES (?, ?)", [`m-${version}`, Date.now()])
}
if (process.env.FAKE_SERVE === "crash") {
  console.error(`fake openforge ${version} crashed on start`)
  process.exit(3)
}

const reported = process.env.FAKE_SERVE === "wrong-version" ? "9.9.9" : version
const switching = process.env.OPENFORGE_UPGRADE_SWITCH
let busy = process.env.FAKE_BUSY === "1"
const streams = new Set<ReadableStreamDefaultController<string>>()
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info")
      return Response.json({ version: reported, pid: process.pid, urls: [], paths: { tmp: "/tmp" }, switching })
    if (url.pathname === "/api/session/active")
      return Response.json({ data: busy ? { ses_fake: { type: "running" } } : {} })
    if (url.pathname.startsWith("/api/experimental/persistent-pty/")) return Response.json({ handoff: null })
    if (url.pathname === "/api/event") {
      const body = new ReadableStream<string>({
        start(controller) {
          streams.add(controller)
          controller.enqueue(event({ id: "evt_connected", type: "server.connected", data: {} }))
        },
        cancel() {},
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (url.pathname === "/fake/idle") {
      busy = false
      streams.forEach((controller) =>
        controller.enqueue(
          event({ id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_fake" } }),
        ),
      )
      return new Response("idle")
    }
    return new Response("not found", { status: 404 })
  },
})

writeFileSync(
  process.env.FAKE_REGISTRATION ?? "",
  JSON.stringify({ id: randomUUID(), version: reported, url: `http://127.0.0.1:${server.port}`, pid: process.pid }),
  { mode: 0o600 },
)
process.on("SIGTERM", () => process.exit(0))
