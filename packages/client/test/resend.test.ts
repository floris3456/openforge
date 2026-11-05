import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid"
import { createResender, findResendTimeout, OpenCode } from "../src/promise"
import { waiting } from "./fixture/wait"

// The data layer over a fake service whose answers the test decides, request by request, with every write sent
// through a resender as the TUI sends them.
function fixture(answer: (request: Request, body: unknown) => Promise<Response> | Response, limit?: number) {
  const requests: { method: string; path: string; body: unknown }[] = []
  const resender = createResender({ limit })
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body: unknown =
      request.method === "GET"
        ? undefined
        : await request
            .clone()
            .json()
            .catch(() => undefined)
    requests.push({ method: request.method, path: new URL(request.url).pathname, body })
    return answer(request, body)
  }
  const api = OpenCode.make({
    baseUrl: "http://openforge.local",
    fetch: resender.fetch(Object.assign(fetch, { preconnect: () => {} })),
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    api,
    resender,
    requests,
    dispose,
  }))
}

const resumed = { type: "service.resumed" }
const switching = () =>
  Response.json(
    { code: "service_switching", message: "switching, try again in 1 s" },
    { status: 503, headers: { "retry-after": "1" } },
  )
// What the fake service reads from a write's body.
const read = (body: unknown) => {
  const value = typeof body === "object" && body !== null ? body : {}
  return {
    id: "id" in value ? value.id : undefined,
    text: "text" in value ? value.text : undefined,
    location: "location" in value ? value.location : undefined,
  }
}
const admitted = (body: unknown) =>
  Response.json({
    data: {
      id: read(body).id,
      sessionID: "ses_switch",
      type: "user",
      delivery: "steer",
      time: { created: 1 },
      payload: { text: read(body).text },
    },
  })

test("a prompt whose model selection is refused during a switch goes in once the service resumes", async () => {
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
        setup.api.session.switchModel({ sessionID: "ses_switch", model: { providerID: "fake", id: "slow" } }),
    })
    await waiting(setup.resender, 1)
    // The prompt is in the transcript while its model selection waits.
    expect(setup.data.session.message.get("ses_switch", "msg_model")).toBeDefined()
    up = true
    setup.resender.observe(resumed)
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
  const setup = fixture((_request, body) => {
    if (!up) return switching()
    return Response.json({
      data: {
        id: read(body).id,
        projectID: "prj_test",
        location: read(body).location,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      },
    })
  })
  try {
    const created = setup.data.session.create({ id: "ses_new", location: { directory: "/project" } })
    await waiting(setup.resender, 1)
    expect(setup.data.session.get("ses_new")).toBeDefined()
    up = true
    setup.resender.observe(resumed)
    expect((await created.request).id).toBe("ses_new")
    const creates = setup.requests.filter((request) => request.path === "/api/session")
    expect(creates.map((request) => read(request.body).id)).toEqual(["ses_new", "ses_new"])
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
    expect(findResendTimeout(error)).toBeDefined()
    expect(setup.data.session.message.get("ses_switch", "msg_late")).toBeUndefined()
    expect(setup.resender.pending()).toBe(0)
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
  const setup = fixture(() => (up ? new Response(null, { status: 204 }) : switching()))
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
    await waiting(setup.resender, 2)
    up = true
    setup.resender.observe(resumed)
    await Promise.all([replied, answered])
    expect(setup.requests.map((request) => request.path)).toEqual([
      "/api/session/ses_switch/permission/per_switch/reply",
      "/api/session/ses_switch/form/frm_switch/reply",
      "/api/session/ses_switch/permission/per_switch/reply",
      "/api/session/ses_switch/form/frm_switch/reply",
    ])
    expect(setup.resender.pending()).toBe(0)
  } finally {
    setup.dispose()
  }
})
