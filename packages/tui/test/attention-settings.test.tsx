import { expect, test } from "bun:test"
import type { Attention } from "@opencode/schema/attention"
import type { Config } from "../src/config"
import { settings } from "../src/component/dialog-config"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

// openforge (notifications step 2): Settings › Alerts has each event's notification and sound, and Subagent done's
// levels. A sound row that moves to a sound plays it once, through the same report as an event, so a connected player
// plays it where you sit; never as a desktop notification.

test("Alerts: the four switches, then each event's rows", () => {
  expect(settings.filter((setting) => setting.category === "Alerts").map((setting) => setting.title)).toEqual([
    "Notifications",
    "Sounds",
    "Volume",
    "Notification protocol",
    "Done: notification",
    "Done: sound",
    "Reply: notification",
    "Reply: sound",
    "Subagent done: notification",
    "Subagent done: sound",
    "Subagent done: levels",
    "Question: notification",
    "Question: sound",
    "Error: notification",
    "Error: sound",
    "Release highlights",
  ])
  const sound = settings.find((setting) => setting.title === "Done: sound")
  expect(sound?.values).toHaveLength(46)
  expect(sound?.values?.slice(0, 2)).toEqual(["off", "alert-01"])
  expect(settings.find((setting) => setting.title === "Subagent done: levels")?.values).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ])
})

async function open(config: Config.Info) {
  const reported: Attention.Occurrence[] = []
  const setup = await createAppFixture({
    width: 100,
    height: 50,
    config: { animations: false, keybinds: { "opencode.settings": "f6" }, ...config },
    fetch: async (url, request) => {
      if (url.pathname !== "/api/experimental/attention/occurrence") return undefined
      reported.push((await request.json()) as Attention.Occurrence)
      // A player follows, which plays the sound.
      return json({ data: { sound: true, desktop: false } })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Settings"))
  return { setup, reported }
}

test("moving a sound row plays the sound it moves to as a preview, and writes cli.json", async () => {
  const { setup, reported } = await open({ attention: { notifications: true, sound: true } })
  await using _ = setup
  await setup.mockInput.typeText("Done: sound")
  await setup.waitForFrame((frame) => /Done: sound\s+bip-bop-01/.test(frame))
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Done: sound\s+bip-bop-02/.test(frame))
  expect(setup.config().attention?.events?.done?.sound).toBe("bip-bop-02")
  const deadline = Date.now() + 5_000
  while (reported.length === 0 && Date.now() < deadline) await Bun.sleep(10)
  expect(reported).toEqual([
    {
      kind: "done",
      title: "openforge",
      message: "Sound preview: bip-bop-02",
      notify: false,
      sound: { name: "done", id: "bip-bop-02" },
      focused: false,
    },
  ])
})

test("a file path set in cli.json shows as such, and stays until changed", async () => {
  const { setup, reported } = await open({
    attention: { notifications: true, sound: true, events: { question: { sound: "/home/me/ding.wav" } } },
  })
  await using _ = setup
  await setup.mockInput.typeText("Question: sound")
  await setup.waitForFrame((frame) => /Question: sound\s+\/home\/me\/ding\.wav/.test(frame))
  expect(reported).toEqual([])
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => /Question: sound\s+off/.test(frame))
  expect(setup.config().attention?.events?.question?.sound).toBe("off")
  // Off has no sound to preview.
  await Bun.sleep(200)
  expect(reported).toEqual([])
})
