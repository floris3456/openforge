import { expect, test } from "bun:test"
import { settings } from "../src/component/dialog-config"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

// openforge's images for Claude Opus 5.5 (spec images-opus-5-5): Settings › Session "Images for Opus 5.5", off by
// default, read from the service's config and written to its global config, never to cli.json.

test("Session has the row Images for Opus 5.5: off or on, off by default, kept by the service", () => {
  const row = settings.find((setting) => setting.title === "Images for Opus 5.5")
  expect(row).toMatchObject({
    category: "Session",
    path: ["media", "image", "opus_5_5"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    service: true,
  })
})

test("the row shows the service's value and writes the service's global config, not cli.json", async () => {
  const writes: unknown[] = []
  const state = { value: undefined as boolean | undefined }
  const document = () => ({
    type: "document",
    info: state.value === undefined ? {} : { media: { image: { opus_5_5: state.value } } },
  })
  await using setup = await createAppFixture({
    width: 120,
    height: 40,
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/config" && request.method === "GET")
        return json([{ type: "document", info: { media: { image: { opus_5_5: false } } } }, document()])
      if (url.pathname !== "/api/experimental/config") return undefined
      const body = (await request.json()) as { media: { image: { opus_5_5: boolean } } }
      writes.push(body)
      state.value = body.media.image.opus_5_5
      return new Response(null, { status: 204 })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  await setup.mockInput.typeText("Images for Opus")
  await setup.waitForFrame((frame) => /Images for Opus 5\.5\s+off/.test(frame))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Images for Opus 5\.5\s+on/.test(frame))
  expect(writes).toEqual([{ media: { image: { opus_5_5: true } } }])
  expect(setup.config()).not.toHaveProperty("media")
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Images for Opus 5\.5\s+off/.test(frame))
  expect(writes).toEqual([{ media: { image: { opus_5_5: true } } }, { media: { image: { opus_5_5: false } } }])
})
