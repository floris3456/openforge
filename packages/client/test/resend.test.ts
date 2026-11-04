import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import {
  ClientError,
  isResendTimeoutError,
  OpenCode,
  ResendTimeoutError,
  resendable,
  type OpenCodeEvent,
} from "../src/promise"

type Handler = (event: OpenCodeEvent) => void

// A data layer over a fake service whose answers the test decides, request by request.
function fixture(answer: (request: Request, body: unknown) => Promise<Response> | Response, resendLimit?: number) {
  const handlers = new Map<string, Set<Handler>>()
  const requests: { method: string; path: string; body: unknown }[] = []
  const api = OpenCode.make({
    baseUrl: "http://openforge.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const body =
        request.method === "GET"
          ? undefined
          : await request
              .clone()
              .json()
              .catch(() => undefined)
      requests.push({ method: request.method, path: new URL(request.url).pathname, body })
      return answer(request, body)
    },
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      resendLimit,
      event: {
        on: (type, handler) => {
          const set = handlers.get(type) ?? new Set()
          set.add(handler as Handler)
          handlers.set(type, set)
          return () => set.delete(handler as Handler)
        },
        listen: () => () => {},
      },
    }),
    api,
    requests,
    emit: (type: "server.connected" | "service.resumed") =>
      handlers
        .get(type)
        ?.forEach((handler) => handler({ id: `evt_${type}`, created: Date.now(), type, data: {} } as OpenCodeEvent)),
    dispose,
  }))
}

const refused = () => {
  throw new TypeError("connect ECONNREFUSED 127.0.0.1:3674")
}
const switching = () =>
  Response.json(
    { code: "service_switching", message: "switching, try again in 1 s" },
    { status: 503, headers: { "retry-after": "1" } },
  )
const admitted = (body: unknown) =>
  Response.json({
    data: {
      id: (body as { id: string }).id,
      sessionID: "ses_switch",
      type: "user",
      delivery: "steer",
      time: { created: 1 },
      payload: { text: (body as { text: string }).text },
    },
  })
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 2 s")
    await Bun.sleep(5)
  }
}

test("only a connection error or a 503 is resent", () => {
  expect(resendable(new ClientError("Transport", { cause: new TypeError("connect ECONNREFUSED") }))).toBe(true)
  expect(resendable(new ClientError("UnexpectedStatus", { cause: { status: 503 }, detail: "503" }))).toBe(true)
  expect(resendable({ code: "service_switching", message: "switching, try again in 1 s" })).toBe(true)
  expect(resendable(new ClientError("UnexpectedStatus", { cause: { status: 500 }, detail: "500" }))).toBe(false)
  expect(resendable({ _tag: "SessionNotFoundError", message: "missing" })).toBe(false)
  const aborted = new DOMException("The operation was aborted.", "AbortError")
  expect(resendable(new ClientError("Transport", { cause: aborted }))).toBe(false)
  // A caller that wraps the failure keeps it resendable; one that already gave up is reported.
  const refusedWrite = new ClientError("UnexpectedStatus", { cause: { status: 503 }, detail: "503" })
  expect(resendable(new Error("Failed to switch model", { cause: refusedWrite }))).toBe(true)
  expect(resendable(new Error("Failed to switch model", { cause: new Error("bad model") }))).toBe(false)
  expect(resendable(new ResendTimeoutError({ cause: refusedWrite }))).toBe(false)
})

test("a prompt whose model selection is refused during a switch is resent with it", async () => {
  let up = false
  const setup = fixture((request, body) => {
    if (!up) return switching()
    if (request.url.endsWith("/model")) return new Response(null, { status: 204 })
    return admitted(body)
  })
  try {
    const sent = setup.data.session.prompt({
      sessionID: "ses_switch",
      id: "msg_model",
      text: "Carry on",
      // As the TUI commits the composer's model before the prompt.
      prepare: () =>
        setup.api.session
          .switchModel({ sessionID: "ses_switch", model: { providerID: "fake", id: "slow" } })
          .catch((error: unknown) => {
            throw new Error("Failed to switch model", { cause: error })
          }),
    })
    await until(() => setup.data.session.resending() === 1)
    up = true
    setup.emit("service.resumed")
    expect((await sent).id).toBe("msg_model")
    expect(setup.requests.map((request) => request.path)).toEqual([
      "/api/session/ses_switch/model",
      "/api/session/ses_switch/model",
      "/api/session/ses_switch/prompt",
    ])
  } finally {
    setup.dispose()
  }
})

test("a new chat started during a switch is created with the same id once the service takes it", async () => {
  let up = false
  const setup = fixture((request, body) => {
    if (!up) return switching()
    const input = body as { id: string; location: { directory: string } }
    return Response.json({
      data: {
        id: input.id,
        projectID: "prj_test",
        location: input.location,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      },
    })
  })
  try {
    const created = setup.data.session.create({ id: "ses_new", location: { directory: "/project" } })
    await until(() => setup.data.session.resending() === 1)
    expect(setup.data.session.get("ses_new")).toBeDefined()
    up = true
    setup.emit("service.resumed")
    expect((await created.request).id).toBe("ses_new")
    const creates = setup.requests.filter((request) => request.path === "/api/session")
    expect(creates.map((request) => (request.body as { id: string }).id)).toEqual(["ses_new", "ses_new"])
  } finally {
    setup.dispose()
  }
})

test("a prompt sent during a switch is resent with the same id once the new service connects and resumes", async () => {
  let phase: "down" | "paused" | "running" = "down"
  const setup = fixture((request, body) => {
    if (!request.url.endsWith("/prompt")) return Response.json({})
    if (phase === "down") return refused()
    if (phase === "paused") return switching()
    return admitted(body)
  })
  try {
    const started = Date.now()
    const sent = setup.data.session.prompt({ sessionID: "ses_switch", id: "msg_switch", text: "Carry on" })
    await until(() => setup.data.session.resending() === 1)
    expect(setup.data.session.message.get("ses_switch", "msg_switch")).toBeDefined()

    // The new release registers paused: the event stream connects, the prompt is refused.
    phase = "paused"
    setup.emit("server.connected")
    await until(() => setup.requests.length === 2)
    // Then it resumes, and the prompt goes in on that event rather than a timer.
    phase = "running"
    setup.emit("service.resumed")
    expect((await sent).id).toBe("msg_switch")
    expect(Date.now() - started).toBeLessThan(900)

    const prompts = setup.requests.filter((request) => request.path.endsWith("/prompt"))
    expect(prompts.map((request) => (request.body as { id: string }).id)).toEqual([
      "msg_switch",
      "msg_switch",
      "msg_switch",
    ])
    expect(setup.data.session.resending()).toBe(0)
  } finally {
    setup.dispose()
  }
})

test("a prompt the service never takes fails after the limit and leaves the transcript", async () => {
  const setup = fixture(() => switching(), 50)
  try {
    const error = await setup.data.session.prompt({ sessionID: "ses_switch", id: "msg_late", text: "Keep me" }).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(isResendTimeoutError(error)).toBe(true)
    expect(setup.data.session.message.get("ses_switch", "msg_late")).toBeUndefined()
    expect(setup.data.session.resending()).toBe(0)
  } finally {
    setup.dispose()
  }
})

test("a write the service rejects for another reason is not resent", async () => {
  const setup = fixture(() => Response.json({ _tag: "SessionNotFoundError", message: "missing" }, { status: 404 }))
  try {
    await expect(setup.data.session.prompt({ sessionID: "ses_gone", text: "Hello" })).rejects.toMatchObject({
      _tag: "SessionNotFoundError",
    })
    expect(setup.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)
  } finally {
    setup.dispose()
  }
})

test("a permission reply and a form answer given during a switch are resent with their own ids", async () => {
  let up = false
  const setup = fixture((request) => {
    if (!up) return switching()
    return new Response(null, { status: 204 })
  })
  try {
    const replied = setup.data.session.permission.reply({
      sessionID: "ses_switch",
      requestID: "per_switch",
      decision: "once",
    })
    const answered = setup.data.session.form.reply({
      sessionID: "ses_switch",
      formID: "frm_switch",
      answer: { q0: "Yes" },
    })
    await until(() => setup.data.session.resending() === 2)
    up = true
    setup.emit("service.resumed")
    await Promise.all([replied, answered])
    expect(setup.requests.map((request) => request.path)).toEqual([
      "/api/session/ses_switch/permission/per_switch/reply",
      "/api/session/ses_switch/form/frm_switch/reply",
      "/api/session/ses_switch/permission/per_switch/reply",
      "/api/session/ses_switch/form/frm_switch/reply",
    ])
    expect(setup.data.session.resending()).toBe(0)
  } finally {
    setup.dispose()
  }
})
