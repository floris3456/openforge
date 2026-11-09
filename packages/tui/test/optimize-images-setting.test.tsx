import { expect, test } from "bun:test"
import { settings } from "../src/component/dialog-config"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

// openforge's optimized images (spec images): Settings › Session "Optimize images", off by default, read from the
// service's config and written to its global config, never to cli.json.

test("Session has the row Optimize images: off or on, off by default, kept by the service, with help", () => {
  const row = settings.find((setting) => setting.title === "Optimize images")
  expect(row).toMatchObject({
    category: "Session",
    path: ["media", "image", "optimize"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    service: true,
  })
  expect(row?.help).toContain("claude-opus-5-5")
  expect(row?.title + row!.description).not.toMatch(/opus/i)
})

test("the row shows the service's value and writes the service's global config, not cli.json", async () => {
  const writes: unknown[] = []
  const state = { value: undefined as boolean | undefined }
  const document = () => ({
    type: "document",
    info: state.value === undefined ? {} : { media: { image: { optimize: state.value } } },
  })
  await using setup = await createAppFixture({
    width: 120,
    height: 40,
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/config" && request.method === "GET")
        return json([{ type: "document", info: { media: { image: { optimize: false } } } }, document()])
      if (url.pathname !== "/api/experimental/config") return undefined
      const body = (await request.json()) as { media: { image: { optimize: boolean } } }
      writes.push(body)
      state.value = body.media.image.optimize
      return new Response(null, { status: 204 })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.mockInput.typeText("Optimize images")
  await setup.waitForFrame((frame) => /Optimize images\s+off/.test(frame))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Optimize images\s+on/.test(frame))
  expect(writes).toEqual([{ media: { image: { optimize: true } } }])
  expect(setup.config()).not.toHaveProperty("media")
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Optimize images\s+off/.test(frame))
  expect(writes).toEqual([{ media: { image: { optimize: true } } }, { media: { image: { optimize: false } } }])
})

test("without the service's answer the row hides", async () => {
  const state = { answered: false }
  await using setup = await createAppFixture({
    width: 120,
    height: 40,
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
    fetch: (url) => {
      if (url.pathname !== "/api/config") return undefined
      state.answered = true
      return new Response("unavailable", { status: 503 })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.mockInput.typeText("Optimize images")
  await setup.waitForFrame((frame) => state.answered && frame.includes("Optimize images") && !/Optimize images\s+off/.test(frame))
  expect(setup.captureCharFrame()).not.toMatch(/Optimize images\s+(off|on)/)
})
