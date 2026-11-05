import { expect, test } from "bun:test"
import { ServiceSwitch } from "@opencode/protocol/service-switch"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { shows, until } from "./fixture/wait"

// An open chat on a service that refuses writes as a paused new release does, or takes them once `up`.
function chat() {
  // The draft stash is process-wide, so each test uses a fresh session for an empty composer.
  const sessionID = `ses_resend_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const state = { up: false, models: 0, prompts: [] as { id: string; text: string }[] }
  const switching = () => json(ServiceSwitch.refused, { status: 503, headers: { "retry-after": "1" } })
  const fetch = async (url: URL, request: Request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Resend fixture",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/model`) {
      state.models++
      return state.up ? new Response(null, { status: 204 }) : switching()
    }
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/prompt`) {
      const body = (await request.json()) as { id: string; text: string }
      state.prompts.push(body)
      if (!state.up) return switching()
      return json({
        data: {
          id: body.id,
          sessionID,
          type: "user",
          delivery: "steer",
          time: { created: 1 },
          payload: { text: body.text },
        },
      })
    }
    return undefined
  }
  return { sessionID, state, fetch }
}

test("a prompt sent while the new release is paused goes in once it resumes, with its model selection", async () => {
  const fake = chat()
  await using setup = await createAppFixture({ fetch: fake.fetch, args: { sessionID: fake.sessionID } })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("carry on after the switch")
  setup.mockInput.pressEnter()
  // Refused while paused: the model selection goes first, so the prompt waits behind it.
  await until(() => fake.state.models > 0)
  expect(fake.state.prompts).toEqual([])
  fake.state.up = true
  setup.events.emit({ id: "evt_resumed", created: Date.now(), type: "service.resumed", data: {} })
  await until(() => fake.state.prompts.length > 0)
  expect(fake.state.models).toBeGreaterThan(1)
  expect(fake.state.prompts.map((prompt) => prompt.text)).toEqual(["carry on after the switch"])
  // The refused model selection was resent, not reported.
  expect(setup.captureCharFrame()).not.toContain("Failed to")
}, 15_000)

test("a prompt the service does not take within the limit goes back in the composer and says so", async () => {
  const fake = chat()
  await using setup = await createAppFixture({
    fetch: fake.fetch,
    args: { sessionID: fake.sessionID },
    resendLimit: 300,
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("keep me through the switch")
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Prompt not sent"))
  await shows(setup, (frame) =>
    frame.includes(
      "openforge did not take it within 300 ms; it was switching releases or could not be reached. It is back in the composer",
    ),
  )
  // The text is back in the composer, not in the transcript.
  const frame = setup.captureCharFrame()
  expect(frame).toContain("keep me through the switch")
  expect(frame).not.toContain("Failed to send prompt")
  expect(fake.state.prompts).toEqual([])
}, 15_000)
