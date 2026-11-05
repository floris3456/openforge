import { afterEach, expect, test } from "bun:test"
import { ServiceSwitch } from "@opencode/protocol/service-switch"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createResender, findResendTimeout, OpenCode } from "../src/promise"
import { waiting } from "./fixture/wait"

type Phase = "down" | "drop" | "paused" | "running"

// A service on a real port that a test takes down, has drop each request it read, pauses or runs, as the service does
// while openforge switches releases.
async function service() {
  const requests: { phase: Phase; method: string; path: string; body: unknown }[] = []
  const hearing = new Set<() => void>()
  let phase: Phase = "running"
  const server: Server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://openforge.local").pathname
      requests.push({ phase, method: request.method ?? "GET", path, body: raw ? JSON.parse(raw) : undefined })
      hearing.forEach((heard) => heard())
      // The old service stops with the request read but not answered.
      if (phase === "drop") return request.socket.destroy()
      // Each request on its own connection, so a dropped one is never a reused socket the runtime retries itself.
      response.setHeader("connection", "close")
      if (phase === "paused") {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "1" })
        return response.end(JSON.stringify(ServiceSwitch.refused))
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
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the fake service has no port")
  const port = (address satisfies AddressInfo).port
  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  const fake = {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Resolves once the service has read `count` requests in all. */
    heard: (count: number) =>
      new Promise<void>((resolve) => {
        const heard = () => {
          if (requests.length < count) return
          hearing.delete(heard)
          resolve()
        }
        hearing.add(heard)
        heard()
      }),
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

// The events after which a waiting write tries again: the stream reached a service, and the new release resumed.
const connected = { type: "server.connected" }
const resumed = { type: "service.resumed" }

function client(url: string, limit?: number) {
  const resender = createResender({ limit })
  return { resender, api: OpenCode.make({ baseUrl: url, fetch: resender.fetch(globalThis.fetch) }) }
}

test("a write the paused new release refuses is resent once it resumes", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url)
  const counts: number[] = []
  resender.watchPending((pending) => counts.push(pending))
  await fake.set("paused")
  const sent = api.session.switchAgent({ sessionID: "ses_a", agent: "plan" })
  await waiting(resender, 1)
  await fake.set("running")
  // Another event does not end the wait.
  resender.observe({ type: "session.status" })
  resender.observe(resumed)
  await sent
  expect(resender.pending()).toBe(0)
  expect(counts).toEqual([1, 0])
  expect(fake.requests.map((request) => `${request.phase} ${request.path}`)).toEqual([
    "paused /api/session/ses_a/agent",
    "running /api/session/ses_a/agent",
  ])
})

test("a write is unanswered from its first attempt until the service answers it, also while it waits", async () => {
  const fake = await service()
  const resender = createResender()
  // The service holds its answer to the command until the test lets it go.
  const held = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    if (!new URL(String(input)).pathname.endsWith("/command")) return globalThis.fetch(input, init)
    reached.resolve()
    return held.promise.then(() => globalThis.fetch(input, init))
  }
  const api = OpenCode.make({
    baseUrl: fake.url,
    fetch: resender.fetch(Object.assign(fetch, { preconnect: () => {} })),
  })
  const counts: number[] = []
  resender.watchUnanswered((unanswered) => counts.push(unanswered))
  const command = api.session.command({ sessionID: "ses_a", id: "msg_command", name: "review" })
  await reached.promise
  // On its way, not waiting to be resent; a read is neither.
  expect(resender.unanswered()).toBe(1)
  expect(resender.pending()).toBe(0)
  await resender.fetch(globalThis.fetch)(new URL("/api/session/ses_a", fake.url))
  expect(resender.unanswered()).toBe(1)
  held.resolve()
  await command
  expect(resender.unanswered()).toBe(0)

  await fake.set("paused")
  const agent = api.session.switchAgent({ sessionID: "ses_a", agent: "plan" })
  await waiting(resender, 1)
  expect(resender.unanswered()).toBe(1)
  await fake.set("running")
  resender.observe(resumed)
  await agent
  expect(resender.unanswered()).toBe(0)
  expect(counts).toEqual([1, 0, 1, 0])
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
  await waiting(resender, 4)
  // The new release registers paused: the event stream connects, and it refuses them until it resumes.
  await fake.set("paused")
  resender.observe(connected)
  await fake.heard(4)
  await waiting(resender, 4)
  await fake.set("running")
  resender.observe(resumed)
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
  await waiting(resender, 4)
  await fake.set("running")
  resender.observe(connected)
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

test("a write the service does not take within the limit is reported as not sent, naming the limit", async () => {
  const fake = await service()
  const { resender, api } = client(fake.url, 300)
  await fake.set("paused")
  const error = await api.session.shell({ sessionID: "ses_a", id: "msg_late", command: "ls" }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  // The generated client wraps it as a transport failure; it is still known as given up.
  expect(error).toMatchObject({ reason: "Transport" })
  expect(findResendTimeout(error)?.message).toBe(
    "openforge did not take it within 300 ms; it was switching releases or could not be reached",
  )
  expect(resender.pending()).toBe(0)
  // Sent at once and, with no event in between, a last time at the limit.
  expect(fake.requests).toHaveLength(2)
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
  await waiting(resender, 1)
  abort.abort()
  expect(await aborted).toBeDefined()
  expect(resender.pending()).toBe(0)

  // Closing the client gives up what still waits.
  const closed = api.session.switchModel({ sessionID: "ses_a", model: { providerID: "fake", id: "slow" } }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await waiting(resender, 1)
  resender.close()
  expect(await closed).toBeDefined()
  expect(resender.pending()).toBe(0)
})

// Sends one write whose first attempt loses its connection after it went out, as when the old service stops with the
// request read; the next attempt is answered.
async function afterDrop(write: { readonly method: string; readonly path: string; readonly body?: string }) {
  const resender = createResender()
  let attempts = 0
  const fetch = async () => {
    attempts++
    if (attempts === 1) throw new TypeError("The socket connection was closed unexpectedly")
    return new Response(null, { status: 204 })
  }
  // Once it waits, the stream reaches the next service.
  resender.watchPending((pending) => {
    if (pending === 1) resender.observe(connected)
  })
  return resender
    .fetch(Object.assign(fetch, { preconnect: () => {} }))(`http://openforge.local/openforge${write.path}`, {
      method: write.method,
      body: write.body,
    })
    .then(
      () => "resent",
      () => "reported",
    )
}

test("the writes resent after a dropped connection are the ones the protocol has", async () => {
  const spec: unknown = await Bun.file(new URL("../../protocol/openapi.json", import.meta.url)).json()
  if (typeof spec !== "object" || spec === null || !("paths" in spec) || typeof spec.paths !== "object" || !spec.paths)
    throw new Error("openapi.json has no paths")
  const writes = Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations ?? {})
      .map((method) => method.toUpperCase())
      .filter((method) => !["GET", "HEAD", "OPTIONS"].includes(method))
      .map((method) => ({ method, path: path.replace(/\{[^}]+\}/g, "x") })),
  )
  // The writes resent, by method; sent under a base URL with a path prefix.
  const resent = async (body?: string) => {
    const outcomes = await Promise.all(
      writes.map(async (write) => ({ ...write, outcome: await afterDrop({ ...write, body }) })),
    )
    const paths = (post: boolean) =>
      outcomes
        .filter((write) => write.outcome === "resent" && (write.method === "POST") === post)
        .map((write) => write.path)
        .toSorted()
    return { posts: paths(true), others: paths(false) }
  }
  // Without an id: every PUT, PATCH and DELETE, and the POSTs that set something or settle a request named in the
  // path.
  const plain = await resent()
  expect(plain.others).toEqual(
    writes
      .filter((write) => write.method !== "POST")
      .map((write) => write.path)
      .toSorted(),
  )
  expect(plain.posts).toEqual([
    "/api/session/x/agent",
    "/api/session/x/form/x/reply",
    "/api/session/x/model",
    "/api/session/x/permission/x/reply",
    "/api/session/x/revert/commit",
    "/api/session/x/revert/stage",
    "/api/session/x/view",
  ])
  // With an id, also those the service runs once per id.
  expect((await resent(JSON.stringify({ id: "msg_a" }))).posts).toEqual([
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
})
