import { afterEach, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createResender, isResendTimeoutError, OpenCode, repeats, resendable } from "../src/promise"

type Phase = "down" | "drop" | "paused" | "running"

// A service on a real port that a test takes down, has drop each request it read, pauses or runs, as the service does
// while openforge switches releases.
async function service() {
  const requests: { phase: Phase; method: string; path: string; body: unknown }[] = []
  let phase: Phase = "running"
  const server: Server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://openforge.local").pathname
      requests.push({ phase, method: request.method ?? "GET", path, body: raw ? JSON.parse(raw) : undefined })
      // The old service stops with the request read but not answered.
      if (phase === "drop") return request.socket.destroy()
      // Each request on its own connection, so a dropped one is never a reused socket the runtime retries itself.
      response.setHeader("connection", "close")
      if (phase === "paused") {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "1" })
        return response.end(JSON.stringify({ code: "service_switching", message: "switching, try again in 1 s" }))
      }
      if (path.endsWith("/revert/stage")) {
        response.writeHead(200, { "content-type": "application/json" })
        return response.end(JSON.stringify({ data: { messageID: "msg_a", files: [] } }))
      }
      response.writeHead(204)
      response.end()
    })
  })
  const listen = (port: number) => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()))
  await listen(0)
  const port = (server.address() as AddressInfo).port
  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  const fake = {
    url: `http://127.0.0.1:${port}`,
    requests,
    async set(next: Phase) {
      if (next === "down" && phase !== "down") await stop()
      if (next !== "down" && phase === "down") await listen(port)
      phase = next
    },
    stop: () => (phase === "down" ? Promise.resolve() : stop()),
  }
  services.push(fake)
  return fake
}
const services: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((fake) => fake.stop()))
})

async function until(condition: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeout} ms`)
    await Bun.sleep(5)
  }
}

function client(url: string, limit?: number) {
  const resender = createResender({ limit })
  return { resender, api: OpenCode.make({ baseUrl: url, fetch: resender.fetch(globalThis.fetch) }) }
}

test("a write the paused new release refuses is resent until it takes it, at once when woken", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url)
  const counts: number[] = []
  resender.subscribe((pending) => counts.push(pending))
  await fake.set("paused")
  const sent = api.session.switchAgent({ sessionID: "ses_a", agent: "plan" })
  await until(() => resender.pending() === 1)
  await fake.set("running")
  const woken = Date.now()
  resender.wake()
  await sent
  // The service advised 1 s; the wake did not wait for that.
  expect(Date.now() - woken).toBeLessThan(500)
  expect(resender.pending()).toBe(0)
  expect(counts).toEqual([1, 0])
  expect(fake.requests.map((request) => `${request.phase} ${request.path}`)).toEqual([
    "paused /api/session/ses_a/agent",
    "running /api/session/ses_a/agent",
  ])
})

test("every kind of write is resent while the service cannot be reached", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url)
  await fake.set("down")
  // A slash command and a `!` command carry no id here: a refused connection never reached a service.
  const writes = [
    api.session.command({ sessionID: "ses_a", name: "review" }),
    api.session.shell({ sessionID: "ses_a", command: "ls" }),
    api.session.form.cancel({ sessionID: "ses_a", formID: "frm_a" }),
    api.session.revert.stage({ sessionID: "ses_a", messageID: "msg_a" }),
  ]
  await until(() => resender.pending() === 4)
  await fake.set("paused")
  resender.wake()
  await until(() => fake.requests.length >= 4)
  await fake.set("running")
  resender.wake()
  await Promise.all(writes)
  const taken = fake.requests
    .filter((request) => request.phase === "running")
    .map((request) => `${request.method} ${request.path}`)
  expect(taken.toSorted()).toEqual([
    "DELETE /api/session/ses_a/form/frm_a",
    "POST /api/session/ses_a/command",
    "POST /api/session/ses_a/revert/stage",
    "POST /api/session/ses_a/shell",
  ])
  expect(resender.pending()).toBe(0)
})

test("after a dropped connection only a write the service may get twice is resent", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url)
  await fake.set("drop")
  // Without an id the service cannot tell the command arrived twice: reported, not resent.
  const unsafe = await api.session.command({ sessionID: "ses_a", name: "review" }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(unsafe).toMatchObject({ reason: "Transport" })
  expect(fake.requests).toHaveLength(1)

  // With its id the service runs it once, and a dismissal or a selection ends up the same.
  const command = api.session.command({ sessionID: "ses_a", id: "msg_command", name: "review" })
  const shell = api.session.shell({ sessionID: "ses_a", id: "msg_shell", command: "sleep 5" })
  const dismissal = api.session.form.cancel({ sessionID: "ses_a", formID: "frm_a" })
  const agent = api.session.switchAgent({ sessionID: "ses_a", agent: "plan" })
  await until(() => resender.pending() === 4)
  await fake.set("running")
  resender.wake()
  await Promise.all([command, shell, dismissal, agent])
  const resent = fake.requests.filter((request) => request.phase === "running")
  expect(resent.map((request) => request.path).toSorted()).toEqual([
    "/api/session/ses_a/agent",
    "/api/session/ses_a/command",
    "/api/session/ses_a/form/frm_a",
    "/api/session/ses_a/shell",
  ])
  expect(resent.find((request) => request.path.endsWith("/command"))?.body).toMatchObject({ id: "msg_command" })
  expect(resent.find((request) => request.path.endsWith("/shell"))?.body).toMatchObject({ id: "msg_shell" })
})

test("a write the service does not take within the limit is reported as not sent", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url, 300)
  await fake.set("paused")
  const error = await api.session.shell({ sessionID: "ses_a", id: "msg_late", command: "ls" }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  // The generated client wraps it as a transport failure; it is still known as given up, and not resent again.
  expect(error).toMatchObject({ reason: "Transport" })
  expect(isResendTimeoutError(error)).toBe(true)
  expect(resendable(error)).toBe(false)
  expect(resender.pending()).toBe(0)
})

test("reads, the switch's own pause and a write the caller aborts are not held back", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url)
  await fake.set("paused")
  const fetch = resender.fetch(globalThis.fetch)
  expect((await fetch(new URL("/api/session/ses_a", fake.url))).status).toBe(503)
  expect((await fetch(new URL("/api/experimental/service/resume", fake.url), { method: "POST" })).status).toBe(503)

  const abort = new AbortController()
  const aborted = api.session.switchAgent({ sessionID: "ses_a", agent: "plan" }, { signal: abort.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await until(() => resender.pending() === 1)
  abort.abort()
  expect(await aborted).toBeDefined()
  expect(resender.pending()).toBe(0)

  // Closing the client gives up what still waits.
  const closed = api.session.switchModel({ sessionID: "ses_a", model: { providerID: "fake", id: "slow" } }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await until(() => resender.pending() === 1)
  resender.close()
  expect(await closed).toBeDefined()
  expect(resender.pending()).toBe(0)
})

test("the writes resent after a dropped connection are the ones the protocol has", async () => {
  const spec = (await Bun.file(new URL("../../protocol/openapi.json", import.meta.url)).json()) as {
    paths: Record<string, Record<string, unknown>>
  }
  const writes = Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .map((method) => method.toUpperCase())
      .filter((method) => !["GET", "HEAD", "OPTIONS"].includes(method))
      .map((method) => ({ method, path: path.replace(/\{[^}]+\}/g, "x") })),
  )
  const posts = (body?: unknown) =>
    writes
      .filter((write) => write.method === "POST" && repeats({ ...write, body }))
      .map((write) => write.path)
      .toSorted()
  // Without an id: those that set something or settle a request named in the path.
  expect(posts()).toEqual([
    "/api/session/x/agent",
    "/api/session/x/form/x/reply",
    "/api/session/x/model",
    "/api/session/x/permission/x/reply",
    "/api/session/x/revert/commit",
    "/api/session/x/revert/stage",
    "/api/session/x/view",
  ])
  // With an id, also those the service runs once per id.
  expect(posts(JSON.stringify({ id: "msg_a" }))).toEqual([
    "/api/session",
    "/api/session/x/agent",
    "/api/session/x/command",
    "/api/session/x/compact",
    "/api/session/x/form/x/reply",
    "/api/session/x/model",
    "/api/session/x/permission/x/reply",
    "/api/session/x/prompt",
    "/api/session/x/revert/commit",
    "/api/session/x/revert/stage",
    "/api/session/x/shell",
    "/api/session/x/synthetic",
    "/api/session/x/view",
  ])
  expect(writes.filter((write) => write.method !== "POST").every((write) => repeats(write))).toBe(true)
  // A base URL with a path prefix matches too.
  expect(repeats({ method: "POST", path: "/openforge/api/session/x/agent" })).toBe(true)
})
