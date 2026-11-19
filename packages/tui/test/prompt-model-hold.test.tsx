import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { shows, until } from "./fixture/wait"

// An open chat on CLIProxyPacer's `late`, whose catalog the service has not read yet: the provider lists no models
// until `catalog` is set to what it lists.
function chat() {
  // The draft stash is process-wide, so each test uses a fresh session for an empty composer.
  const sessionID = `ses_hold_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const state = {
    catalog: undefined as string[] | undefined,
    prompts: [] as { id: string; text: string }[],
    models: [] as { providerID: string; id: string }[],
  }
  const model = (providerID: string, id: string) => ({ id, providerID, name: id, variants: [] })
  const fetch = async (url: URL, request: Request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Hold fixture",
          agent: "build",
          model: { providerID: "cliproxypacer", id: "late" },
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
    if (url.pathname === "/api/provider")
      return json({
        location,
        data: [
          { id: "demo", name: "Demo" },
          { id: "cliproxypacer", name: "CLIProxyPacer" },
        ],
      })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [model("demo", "model"), ...(state.catalog ?? []).map((id) => model("cliproxypacer", id))],
      })
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/model`) {
      state.models.push(((await request.json()) as { model: { providerID: string; id: string } }).model)
      return new Response(null, { status: 204 })
    }
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/prompt`) {
      const body = (await request.json()) as { id: string; text: string }
      state.prompts.push(body)
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

async function open(fake: ReturnType<typeof chat>) {
  const setup = await createAppFixture({ fetch: fake.fetch, args: { sessionID: fake.sessionID } })
  await setup.ready
  await shows(setup, (frame) => frame.includes("late (unavailable)"))
  return setup
}

function catalogArrives(setup: Awaited<ReturnType<typeof open>>, fake: ReturnType<typeof chat>, models: string[]) {
  fake.state.catalog = models
  setup.events.emit({ id: "evt_model", created: Date.now(), type: "model.updated", data: {}, location: { directory } })
}

test("a prompt sent before CLIProxyPacer's catalog is held, then sent once on the named model", async () => {
  const fake = chat()
  await using setup = await open(fake)
  await setup.mockInput.typeText("start right away")
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Sends when late is available · Esc keeps it as a draft"))
  expect(setup.captureCharFrame()).not.toContain("Model unavailable")
  expect(fake.state.prompts).toEqual([])

  catalogArrives(setup, fake, ["late"])
  await until(() => fake.state.prompts.length > 0)
  expect(fake.state.prompts.map((prompt) => prompt.text)).toEqual(["start right away"])
  expect(fake.state.models.at(-1)).toEqual({ providerID: "cliproxypacer", id: "late" })
  await shows(setup, (frame) => !frame.includes("Sends when"))
  await Bun.sleep(200)
  expect(fake.state.prompts).toHaveLength(1)
}, 15_000)

test("Esc during the hold keeps the prompt as an unsent draft", async () => {
  const fake = chat()
  await using setup = await open(fake)
  await setup.mockInput.typeText("not yet")
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Sends when late is available"))
  setup.mockInput.pressEscape()
  await shows(setup, (frame) => !frame.includes("Sends when"))
  expect(setup.captureCharFrame()).toContain("not yet")

  catalogArrives(setup, fake, ["late"])
  await shows(setup, (frame) => !frame.includes("late (unavailable)"))
  await Bun.sleep(200)
  expect(fake.state.prompts).toEqual([])
  expect(setup.captureCharFrame()).toContain("not yet")
}, 15_000)

test("a catalog that comes without the named model says so and keeps the prompt", async () => {
  const fake = chat()
  await using setup = await open(fake)
  await setup.mockInput.typeText("keep this text")
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Sends when late is available"))

  catalogArrives(setup, fake, ["other"])
  await shows(setup, (frame) => frame.includes("cliproxypacer/late is not available"))
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain("Sends when")
  expect(frame).toContain("keep this text")
  expect(fake.state.prompts).toEqual([])
}, 15_000)
