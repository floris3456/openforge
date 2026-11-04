import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

type Listener = (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void

// A data layer over a fake service; `status` answers the service's pause status, `emit` delivers an event.
function fixture(status: () => Promise<Response> | Response) {
  const listeners = new Set<Listener>()
  const api = OpenCode.make({
    baseUrl: "http://openforge.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname === "/api/experimental/service/status") return status()
      return Response.json({ data: {} })
    },
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }),
    emit: (type: OpenCodeEvent["type"], data: unknown = {}) => {
      const event = { id: `evt_${type}`, created: Date.now(), type, data } as OpenCodeEvent
      listeners.forEach((listener) => listener({ name: type, details: event }))
    },
    dispose,
  }))
}

const answer = (state: "running" | "pausing" | "paused", extra: Record<string, unknown> = {}) =>
  Response.json({ data: { state, startedPaused: false, waiting: [], rested: [], active: [], ...extra } })
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 2 s")
    await Bun.sleep(5)
  }
}
const work = [{ sessionID: "ses_a", kind: "tool" as const, name: "webfetch" }]

test("follows a switch from the pause to the new release's resume", async () => {
  let state: "running" | "paused" = "running"
  const setup = fixture(() => answer(state, { startedPaused: state === "paused" }))
  try {
    setup.emit("server.connected")
    await Bun.sleep(20)
    expect(setup.data.service.pause()).toBeUndefined()
    setup.emit("service.pausing", { deadline: Date.now() + 120_000, waiting: work })
    expect(setup.data.service.pause()).toEqual({ state: "pausing", waiting: work })
    setup.emit("service.paused", { rested: ["ses_a"] })
    expect(setup.data.service.pause()).toEqual({ state: "paused" })
    // The old service stops; the stream reaches the new release, started paused.
    state = "paused"
    setup.emit("server.connected")
    await Bun.sleep(20)
    expect(setup.data.service.pause()).toEqual({ state: "paused" })
    setup.emit("service.resumed")
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("a screen that connects during a switch reads it from the service", async () => {
  let state: "pausing" | "paused" | "running" = "pausing"
  const setup = fixture(() => answer(state, state === "pausing" ? { waiting: work } : {}))
  try {
    setup.emit("server.connected")
    await until(() => setup.data.service.pause() !== undefined)
    expect(setup.data.service.pause()).toEqual({ state: "pausing", waiting: work })
    // It missed the resume while it reconnected.
    state = "running"
    setup.emit("server.connected")
    await until(() => setup.data.service.pause() === undefined)
  } finally {
    setup.dispose()
  }
})

test("an event that arrives while the status is read wins over the older answer", async () => {
  const pending = Promise.withResolvers<Response>()
  const setup = fixture(() => pending.promise)
  try {
    setup.emit("server.connected")
    setup.emit("service.resumed")
    pending.resolve(answer("paused"))
    await Bun.sleep(20)
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("a pause that gave up, and a service that cannot pause, are no switch", async () => {
  const setup = fixture(() => new Response(null, { status: 404 }))
  try {
    setup.emit("service.pausing", { deadline: Date.now() + 120_000, waiting: work })
    setup.emit("service.pause.expired", { waiting: work })
    expect(setup.data.service.pause()).toBeUndefined()
    setup.emit("service.paused", { rested: [] })
    setup.emit("server.connected")
    await until(() => setup.data.service.pause() === undefined)
  } finally {
    setup.dispose()
  }
})
