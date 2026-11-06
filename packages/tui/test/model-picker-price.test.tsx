import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
const rate = (input: number, output: number) => ({ input, output, cache: { read: 0, write: 0 } })
const model = (providerID: string, id: string, name: string, cost: unknown[]) => ({
  id,
  modelID: id,
  providerID,
  name,
  status: "active",
  enabled: true,
  cost,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 200_000, output: 64_000 },
  variants: [],
  time: { released: 1 },
})
// CLIProxyPacer's models as the server lists them: one CPP prices, with a context tier, and one it has no price for,
// which has no cost rows. OpenCode's free model, one all-zero row, is what the picker does call free.
const models = [
  model("cliproxypacer", "claude-test-1", "Claude Test 1", [
    rate(3, 15),
    { tier: { type: "context", size: 200_000 }, ...rate(6, 22.5) },
  ]),
  model("cliproxypacer", "plain-1", "Plain One", []),
  // A context of 0 is one CPP does not know.
  {
    ...model("cliproxypacer", "window-1", "Unknown Window", [rate(1, 2)]),
    capabilities: { tools: true, input: ["text", "pdf"], output: ["text"] },
    limit: { context: 0, output: 0 },
  },
  model("opencode", "big-pickle", "Big Pickle", [rate(0, 0)]),
]

async function picker(input: { newDesigns: boolean; connected: boolean }) {
  const state = await tmpdir()
  const setup = await createAppFixture({
    width: 110,
    height: 36,
    state: state.path,
    config: { animations: false, tabs: { mode: "off" }, experimental: { "new-designs": input.newDesigns } },
    fetch: (url) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider")
        return json({
          location,
          data: [
            { id: "cliproxypacer", integrationID: "cliproxypacer", name: "CLIProxyPacer" },
            { id: "opencode", integrationID: "opencode", name: "OpenCode" },
          ],
        })
      if (url.pathname === "/api/model") return json({ location, data: models })
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [
            {
              id: "cliproxypacer",
              name: "CLIProxyPacer",
              methods: [],
              connections: input.connected
                ? [{ type: "credential", method: "key", id: "cred_cpp", label: "CLIProxyPacer" }]
                : [],
            },
          ],
        })
      return undefined
    },
  })
  await setup.ready
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await setup.mockInput.typeText("/models")
  setup.mockInput.pressEnter()
  // The picker focuses its filter on a timer; keys typed before it would go to the prompt.
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof InputRenderable)
  return {
    setup,
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

/** The frame's line that holds `text`, other than the prompt's, which names the current model. */
function line(frame: string, text: string) {
  return frame.split("\n").find((item) => item.includes(text) && !item.includes("Build ·")) ?? ""
}

test("the model list marks OpenCode's free model Free, and neither of CLIProxyPacer's", async () => {
  await using fixture = await picker({ newDesigns: false, connected: true })
  const frame = await fixture.setup.waitForFrame(
    (frame) => frame.includes("Select model") && models.every((item) => line(frame, item.name) !== ""),
  )
  expect(line(frame, "Big Pickle")).toContain("Free")
  expect(line(frame, "Plain One")).not.toContain("Free")
  expect(line(frame, "Claude Test 1")).not.toContain("Free")
})

test("the detail row shows a priced CLIProxyPacer model's price, and no price for an unpriced one", async () => {
  await using fixture = await picker({ newDesigns: true, connected: true })
  const setup = fixture.setup
  // The detail row is the selected model's: its price, then its input and context.
  const detail = (frame: string) => line(frame, "Text · 200K")
  for (const [query, price] of [
    ["Claude Test 1", "$3/$15"],
    ["Big Pickle", "Free"],
    ["Plain One", undefined],
  ] as const) {
    await setup.waitForFrame((frame) => frame.includes("Search models"))
    await setup.mockInput.typeText(query)
    // Once the filter leaves only this model, it is the selected one, whose details the row shows.
    const frame = await setup.waitForFrame(
      (frame) =>
        models.every((item) => item.name === query || line(frame, item.name) === "") &&
        detail(frame) !== "" &&
        (price === undefined || detail(frame).includes(price)),
    )
    if (price === undefined) {
      expect(detail(frame)).not.toContain("Free")
      expect(detail(frame)).not.toContain("$")
    }
    for (const _ of query) setup.mockInput.pressBackspace()
  }
})

test("the detail row leaves out a context window that is unknown", async () => {
  await using fixture = await picker({ newDesigns: true, connections: stored })
  const setup = fixture.setup
  await setup.waitForFrame((frame) => frame.includes("Search models"))
  await setup.mockInput.typeText("Unknown Window")
  const frame = await setup.waitForFrame(
    (frame) =>
      models.every((item) => item.name === "Unknown Window" || line(frame, item.name) === "") &&
      line(frame, "Text, PDF") !== "",
  )
  // Its price, then its input, and nothing for the context.
  expect(line(frame, "Text, PDF").trim()).toMatch(/^\$1\/\$2 +Text, PDF$/)
})

test("the free picker, before anything is connected, offers no CLIProxyPacer model as free", async () => {
  await using fixture = await picker({ newDesigns: true, connected: false })
  const frame = await fixture.setup.waitForFrame((frame) => line(frame, "Big Pickle") !== "")
  expect(line(frame, "Plain One")).toBe("")
  expect(line(frame, "Claude Test 1")).toBe("")
})
