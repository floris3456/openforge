/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { createEffect } from "solid-js"
import { Keymap } from "../../src/context/keymap"
import { CHAT, chat, pacerFake, renderPacer, status, Toolbar } from "./fixture"

// Section 6 of spec cliproxypacer-step-1, its first two bullets: the keys OpenCodePlus has and the palette entries.

async function switches(input: { providerID?: string; state?: Parameters<typeof status>[0] } = {}) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  fake.chats[CHAT] = chat()
  let commands: readonly KeymapCommand[] = []
  function Commands() {
    const list = Keymap.useCommands()
    createEffect(() => (commands = list()))
    return null
  }
  const setup = await renderPacer({
    fake,
    width: 100,
    height: 3,
    sessions: { [CHAT]: { providerID: input.providerID ?? "cliproxypacer" } },
    content: () => (
      <>
        <Commands />
        <Toolbar sessionID={CHAT} />
      </>
    ),
  })
  const palette = () =>
    commands.filter((command) => command.palette && command.group === "CLIProxyPacer").map((command) => command.title)
  return { ...setup, fake, palette }
}

const updates = (fake: ReturnType<typeof pacerFake>) =>
  fake.calls.filter((call) => call.method === "PATCH").map((call) => ({ path: call.path, body: call.body }))

test("<leader>k switches the chat's warming, and the toolbar shows the answer at once", async () => {
  await using setup = await switches()
  await setup.frame((frame) => frame.includes("warm 23:41"))
  setup.app.mockInput.pressKey("x", { ctrl: true })
  setup.app.mockInput.pressKey("k")
  await setup.frame((frame) => frame.includes("warming off · warm 23:41"))
  expect(updates(setup.fake)).toEqual([{ path: `chat/${CHAT}`, body: { warming: false } }])
  // And back on.
  setup.app.mockInput.pressKey("x", { ctrl: true })
  setup.app.mockInput.pressKey("k")
  await setup.frame((frame) => frame.includes("warm 23:41") && !frame.includes("warming off"))
  expect(updates(setup.fake).at(-1)).toEqual({ path: `chat/${CHAT}`, body: { warming: true } })
})

test("<leader>j switches compact before cold", async () => {
  await using setup = await switches()
  await setup.frame((frame) => frame.includes("warm 23:41"))
  setup.app.mockInput.pressKey("x", { ctrl: true })
  setup.app.mockInput.pressKey("j")
  await setup.frame(() => setup.fake.calls.some((call) => call.method === "PATCH" && call.done !== undefined))
  expect(updates(setup.fake)).toEqual([{ path: `chat/${CHAT}`, body: { compactBeforeCold: true } }])
  await setup.frame(() => setup.pacer.view(CHAT)?.value.switches.compactBeforeCold === true)
})

test("the palette has both for a chat on CPP, and they run the same switch", async () => {
  await using setup = await switches()
  await setup.frame((frame) => frame.includes("warm 23:41"))
  expect(setup.palette()).toEqual(["Cache warming for this chat", "Compact before cold for this chat"])
  setup.dispatch("pacer.warming.toggle")
  await setup.frame((frame) => frame.includes("warming off"))
  setup.dispatch("pacer.compact_before_cold.toggle")
  await setup.frame(() => updates(setup.fake).length === 2)
  expect(updates(setup.fake)).toEqual([
    { path: `chat/${CHAT}`, body: { warming: false } },
    { path: `chat/${CHAT}`, body: { compactBeforeCold: true } },
  ])
})

test("neither key nor palette entry for a chat on another provider, on a plain proxy, or without CPP", async () => {
  for (const input of [{ providerID: "anthropic" }, { state: "no-pacer" as const }, { state: "unset" as const }]) {
    await using setup = await switches(input)
    await setup.settle()
    expect(setup.palette()).toEqual([])
    setup.app.mockInput.pressKey("x", { ctrl: true })
    setup.app.mockInput.pressKey("k")
    await Bun.sleep(30)
    expect(updates(setup.fake)).toEqual([])
  }
})

test("CPP refusing the change leaves the toolbar as it was", async () => {
  await using setup = await switches()
  await setup.frame((frame) => frame.includes("warm 23:41"))
  setup.fake.unavailable = true
  setup.dispatch("pacer.warming.toggle")
  await setup.frame(() => setup.fake.calls.some((call) => call.method === "PATCH" && call.done !== undefined))
  await Bun.sleep(20)
  expect(setup.app.captureCharFrame()).toContain("warm 23:41")
  expect(setup.app.captureCharFrame()).not.toContain("warming off")
})
