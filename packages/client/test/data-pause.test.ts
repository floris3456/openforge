import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

type Listener = (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void
/** A read of the service's pause status the data layer made: `answer` it, then await `taken` to see what it did. */
type Read = { readonly answer: (response: Response) => void; readonly taken: Promise<unknown> }

// A data layer over a fake service that holds each read of its pause status until the test answers it; `emit`
// delivers an event.
function fixture() {
  const listeners = new Set<Listener>()
  const answers: Array<(response: Response) => void> = []
  const taken: Array<Promise<unknown>> = []
  const asked = new Set<() => void>()
  const api = OpenCode.make({
    baseUrl: "http://openforge.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname !== "/api/experimental/service/status") return Response.json({ data: {} })
      return new Promise<Response>((resolve) => {
        answers.push(resolve)
        asked.forEach((ask) => ask())
      })
    },
  })
  // The data layer handles the answer on the promise it got before the test awaits that promise, so once `taken`
  // settles the data layer has taken the answer in.
  const service = {
    ...api.experimental.service,
    status: (...input: Parameters<typeof api.experimental.service.status>) => {
      const status = api.experimental.service.status(...input)
      taken.push(status.catch(() => undefined))
      return status
    },
  }
  const watched = { ...api, experimental: { ...api.experimental, service } }
  let reads = 0
  const read = () =>
    new Promise<Read>((resolve) => {
      const ask = () => {
        if (answers.length <= reads || taken.length <= reads) return
        asked.delete(ask)
        resolve({ answer: answers[reads], taken: taken[reads] })
        reads++
      }
      asked.add(ask)
      ask()
    })
  return createRoot((dispose) => ({
    data: createData({
      api: () => watched,
      directory: "/project",
      event: {
        on: () => () => {},
        listen: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }),
    read,
    /** Answers the next read and waits until the data layer has taken the answer in. */
    reply: async (response: Response) => {
      const next = await read()
      next.answer(response)
      await next.taken
    },
    emit: (type: OpenCodeEvent["type"], data: unknown = {}) => {
      const event = { id: `evt_${type}`, created: Date.now(), type, data } as OpenCodeEvent
      listeners.forEach((listener) => listener({ name: type, details: event }))
    },
    dispose,
  }))
}

const answer = (state: "running" | "pausing" | "paused", extra: Record<string, unknown> = {}) =>
  Response.json({ data: { state, startedPaused: false, waiting: [], rested: [], active: [], ...extra } })
const work = [{ sessionID: "ses_a", kind: "tool" as const, name: "webfetch" }]

test("follows a switch from the pause to the new release's resume", async () => {
  const setup = fixture()
  try {
    setup.emit("server.connected")
    await setup.reply(answer("running"))
    expect(setup.data.service.pause()).toBeUndefined()
    setup.emit("service.pausing", { deadline: Date.now() + 120_000, waiting: work })
    expect(setup.data.service.pause()).toEqual({ state: "pausing", waiting: work })
    setup.emit("service.paused", { rested: ["ses_a"] })
    expect(setup.data.service.pause()).toEqual({ state: "paused" })
    // The old service stops; the stream reaches the new release, started paused, which says so.
    setup.emit("server.connected")
    await setup.reply(answer("paused", { startedPaused: true }))
    expect(setup.data.service.pause()).toEqual({ state: "paused" })
    setup.emit("service.resumed")
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("a screen that connects during a switch reads it from the service", async () => {
  const setup = fixture()
  try {
    setup.emit("server.connected")
    await setup.reply(answer("pausing", { waiting: work }))
    expect(setup.data.service.pause()).toEqual({ state: "pausing", waiting: work })
    // It missed the resume while it reconnected.
    setup.emit("server.connected")
    await setup.reply(answer("running"))
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("an event that arrives while the status is read wins over the older answer", async () => {
  const setup = fixture()
  try {
    setup.emit("server.connected")
    const older = await setup.read()
    setup.emit("service.resumed")
    older.answer(answer("paused"))
    await older.taken
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("a pause that gave up, and a service that cannot pause, are no switch", async () => {
  const setup = fixture()
  try {
    setup.emit("service.pausing", { deadline: Date.now() + 120_000, waiting: work })
    setup.emit("service.pause.expired", { waiting: work })
    expect(setup.data.service.pause()).toBeUndefined()
    setup.emit("service.paused", { rested: [] })
    // A release from before 0.1.0 has no pause status.
    setup.emit("server.connected")
    await setup.reply(new Response(null, { status: 404 }))
    expect(setup.data.service.pause()).toBeUndefined()
  } finally {
    setup.dispose()
  }
})
