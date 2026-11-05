// A stand-in for an openforge release binary. The shell script written by `fakeBinary` sets FAKE_VERSION and
// FAKE_SERVE; `--version` prints the version and `serve --service [--paused]` registers a small service that answers
// the requests a release switch makes.
//   FAKE_SERVE=ok             answers with its version
//   FAKE_SERVE=crash          records its migration, then exits 3
//   FAKE_SERVE=wrong-version  answers with version 9.9.9
//   FAKE_SERVE=unreadable     answers with its version but cannot read its database
//   FAKE_SERVE=runner-lost    answers with its version but can't reach the tool runner of 0.1.0
//   FAKE_SERVE=held           answers with its version, but its status, which a switch checks, waits for
//                             POST /fake/check; with `?runner=lost` it then can't reach the tool runner of 0.1.0
//   FAKE_SERVE=unresumable    answers with its version, but stays paused when asked to resume
//   FAKE_PRINT                what --version prints instead of the version
// The service records `m-<version>` in the database's migration journal, as a release migrating it would, and appends
// what happens to it to FAKE_LOG: `<version> started [paused]`, `paused`, `resumed`, `stopped`, `prompt <id>`.
// Like the real releases, one before 0.1.0 has no pause, refuses `--paused` and answers 404 under
// /api/experimental/service/. From 0.1.0 on it pauses at once unless the test gave it work (POST /fake/work), which
// holds the pause until POST /fake/finish ends it or the pause gives up. Started paused it refuses writes with 503,
// except those a paused start answers (`ServiceSwitch.answers`), the terminals' handoff among them.
// It counts the reads of its status and of its running chats, so a test can tell that a wait has read them again
// after an event (POST /fake/reads).
// With FAKE_TERMINALS=1 it holds persistent terminals: asked for their handoff it answers with the ticket
// `ticket-<version>` and records `handoff ticket-<version>`; started with a ticket (OPENCODE_PTY_HANDOFF), it records
// `adopts <ticket>` first thing, before it can crash.
import { Database } from "bun:sqlite"
import { ServiceSwitch } from "@opencode/protocol/service-switch"
import { randomUUID } from "node:crypto"
import { appendFileSync, writeFileSync } from "node:fs"

type Work = { sessionID?: string; kind: "step" | "tool" | "model"; name: string }

const version = process.env.FAKE_VERSION ?? "0.0.0"
const args = process.argv.slice(2)
const [major, minor] = version.split(".").map(Number)
const pausable = major > 0 || minor >= 1
const record = (line: string) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${version} ${line}\n`)
}

if (args[0] === "--version") {
  console.log(`openforge v${process.env.FAKE_PRINT ?? version}`)
  process.exit(0)
}

const paused = args[2] === "--paused"
if (args[0] !== "serve" || args[1] !== "--service" || args.length > 3 || (args.length === 3 && !paused)) {
  console.error(`fake openforge ${version}: unexpected arguments ${args.join(" ")}`)
  process.exit(2)
}
if (paused && !pausable) {
  console.error(`fake openforge ${version}: unknown flag --paused`)
  process.exit(2)
}

const terminals = process.env.FAKE_TERMINALS === "1"
const inherited = process.env.OPENCODE_PTY_HANDOFF
if (terminals && inherited) record(`adopts ${(JSON.parse(inherited) as { ticket: string }).ticket}`)

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
let state: "running" | "pausing" | "paused" = paused ? "paused" : "running"
let startedPaused = paused
let work: Work[] = []
let settled: (() => void) | undefined
const streams = new Set<ReadableStreamDefaultController<string>>()
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const publish = (type: string, data: unknown) =>
  streams.forEach((controller) => {
    try {
      controller.enqueue(event({ id: `evt_${randomUUID()}`, type, created: Date.now(), data }))
    } catch {
      // The subscriber went away.
      streams.delete(controller)
    }
  })
const lost = { version: "0.1.0", reachable: false, reason: "it speaks no protocol this release knows" }
let runners = process.env.FAKE_SERVE === "runner-lost" ? [lost] : []
const checked = Promise.withResolvers<void>()
if (process.env.FAKE_SERVE !== "held") checked.resolve()
const status = () => ({ state, startedPaused, waiting: work, rested: [], active: [], runners })
const reads = { status: 0, active: 0 }
const readers = new Set<() => void>()
const read = (of: keyof typeof reads) => {
  reads[of]++
  readers.forEach((reader) => reader())
}
// Resolves once `of` has been read `count` times in all.
const readsOf = (of: keyof typeof reads, count: number) =>
  new Promise<void>((resolve) => {
    const reader = () => {
      if (reads[of] < count) return
      readers.delete(reader)
      resolve()
    }
    readers.add(reader)
    reader()
  })

const pause = async (timeout: number) => {
  if (work.length === 0) {
    state = "paused"
    record("paused")
    publish("service.paused", { rested: ["ses_fake"] })
    return { paused: true, rested: ["ses_fake"] }
  }
  state = "pausing"
  publish("service.pausing", { deadline: Date.now() + timeout, waiting: work })
  const done = await Promise.race([
    new Promise<boolean>((resolve) => (settled = () => resolve(true))),
    Bun.sleep(timeout).then(() => false),
  ])
  settled = undefined
  if (done) {
    state = "paused"
    record("paused")
    publish("service.paused", { rested: ["ses_fake"] })
    return { paused: true, rested: ["ses_fake"] }
  }
  state = "running"
  record("pause expired")
  publish("service.pause.expired", { waiting: work })
  return { paused: false, waiting: work }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info")
      return Response.json({ version: reported, pid: process.pid, urls: [], paths: { tmp: "/tmp" }, switching })
    if (startedPaused && !ServiceSwitch.answers(request.method, url.pathname) && !url.pathname.startsWith("/fake/"))
      return Response.json(ServiceSwitch.refused, { status: 503, headers: { "retry-after": "1" } })
    if (url.pathname === ServiceSwitch.handoff && terminals) {
      const ticket = `ticket-${version}`
      record(`handoff ${ticket}`)
      return Response.json({
        handoff: { directory: "/fake/pty", instanceID: "fake", ticket, expiresAt: Date.now() + 60_000 },
      })
    }
    if (url.pathname.startsWith("/api/experimental/persistent-pty/")) return Response.json({ handoff: null })
    if (url.pathname.startsWith(ServiceSwitch.path) && !pausable) return new Response(null, { status: 404 })
    if (url.pathname === "/api/experimental/service/status") {
      await checked.promise
      read("status")
      return Response.json({ data: status() })
    }
    if (url.pathname === "/api/experimental/service/pause") {
      const body = (await request.json()) as { timeout?: number }
      return Response.json({ data: await pause(body.timeout ?? 120_000) })
    }
    if (url.pathname === "/api/experimental/service/resume") {
      if (process.env.FAKE_SERVE === "unresumable") return Response.json({ data: status() })
      state = "running"
      startedPaused = false
      record("resumed")
      publish("service.resumed", {})
      return Response.json({ data: status() })
    }
    if (url.pathname === "/api/session") {
      if (process.env.FAKE_SERVE === "unreadable")
        return Response.json({ code: "database", message: "database disk image is malformed" }, { status: 500 })
      return Response.json({ data: [], cursor: { next: null, previous: null } })
    }
    if (url.pathname === "/api/session/active") {
      read("active")
      return Response.json({ data: busy ? { ses_fake: { type: "running" } } : {} })
    }
    // Chats the test names: `ses_a` is titled, `ses_untitled` has no title yet; any other is unknown.
    const session = url.pathname.match(/^\/api\/session\/(ses_a|ses_untitled)$/)
    if (session && request.method === "GET")
      return Response.json({ data: { id: session[1], ...(session[1] === "ses_a" ? { title: "Fix the tests" } : {}) } })
    const prompt = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/)
    if (prompt) {
      const body = (await request.json()) as { id: string; text: string }
      record(`prompt ${body.id}`)
      return Response.json({
        data: {
          id: body.id,
          sessionID: prompt[1],
          type: "user",
          delivery: "steer",
          time: { created: 1 },
          payload: { text: body.text },
        },
      })
    }
    if (url.pathname === "/api/event") {
      let subscriber: ReadableStreamDefaultController<string> | undefined
      const body = new ReadableStream<string>({
        start(controller) {
          subscriber = controller
          streams.add(controller)
          controller.enqueue(event({ id: "evt_connected", type: "server.connected", data: {} }))
        },
        cancel() {
          if (subscriber) streams.delete(subscriber)
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (url.pathname === "/fake/busy") {
      busy = true
      return new Response("busy")
    }
    if (url.pathname === "/fake/idle") {
      busy = false
      publish("session.execution.succeeded", { sessionID: "ses_fake" })
      return new Response("idle")
    }
    // Another chat's execution ends while `ses_fake` keeps running.
    if (url.pathname === "/fake/executed") {
      publish("session.execution.succeeded", { sessionID: "ses_other" })
      return new Response("executed")
    }
    // `?of=status|active`: how often that was read; with `&count=N`, once it has been read N times.
    if (url.pathname === "/fake/reads") {
      const of = url.searchParams.get("of") === "active" ? "active" : "status"
      const count = url.searchParams.get("count")
      if (count !== null) await readsOf(of, Number(count))
      return new Response(String(reads[of]))
    }
    if (url.pathname === "/fake/check") {
      if (url.searchParams.get("runner") === "lost") runners = [lost]
      checked.resolve()
      return new Response("checked")
    }
    if (url.pathname === "/fake/work") {
      work = (await request.json()) as Work[]
      return new Response("working")
    }
    // A chat's step ends and its next one starts at once: the work it reports stays the same.
    if (url.pathname === "/fake/step") {
      publish("session.step.ended", { sessionID: url.searchParams.get("sessionID"), assistantMessageID: "msg_fake" })
      return new Response("stepped")
    }
    // Ends the work of one chat: its tool returns, as `session.tool.success` reports.
    if (url.pathname === "/fake/finish") {
      const sessionID = url.searchParams.get("sessionID") ?? undefined
      work = work.filter((item) => item.sessionID !== sessionID)
      publish("session.tool.success", { sessionID, assistantMessageID: "msg_fake", id: "call_fake" })
      if (work.length === 0) settled?.()
      return new Response("finished")
    }
    return new Response("not found", { status: 404 })
  },
})

writeFileSync(
  process.env.FAKE_REGISTRATION ?? "",
  JSON.stringify({ id: randomUUID(), version: reported, url: `http://127.0.0.1:${server.port}`, pid: process.pid }),
  { mode: 0o600 },
)
record(paused ? "started paused" : "started")
process.on("SIGTERM", () => {
  record("stopped")
  process.exit(0)
})
