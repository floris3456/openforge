/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { PacerAccount } from "../../src/pacer/account"
import { builtins } from "../../src/plugin/builtins"
import { recordFrames } from "../fixture/frames"
import { until } from "../fixture/wait"
import { accounts, CHAT, chat, colorOf, NOW, pacerFake, renderPacer, status, styleOf } from "./fixture"

// Section 5 of spec cliproxypacer-step-1: the sidebar's Account section, where Context was.

async function sidebar(input: {
  state?: Parameters<typeof status>[0]
  view?: ReturnType<typeof chat> | null
  accounts?: ReturnType<typeof accounts> | null
  providerID?: string
}) {
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  if (input.view !== null) fake.chats[CHAT] = input.view ?? chat()
  fake.accounts = input.accounts === undefined ? accounts() : input.accounts
  const setup = await renderPacer({
    fake,
    width: 40,
    height: 12,
    sessions: { [CHAT]: { providerID: input.providerID ?? "cliproxypacer" } },
    content: () => (
      <box width={37}>
        <PacerAccount sessionID={CHAT} />
      </box>
    ),
  })
  return { ...setup, fake }
}

const lines = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

describe("the Account section", () => {
  test("the account serving the chat, each window, and where the chat goes next once its cache is cold", async () => {
    await using setup = await sidebar({ view: chat({ nextUse: { account: "max-1", reason: "cold_move" } }) })
    const frame = await setup.frame((frame) => frame.includes("5h") && frame.includes("next:"))
    expect(lines(frame)).toEqual([
      "Account",
      "max-2",
      "5h  62% left · resets 1:20",
      "7d  80% left · resets ~3d 4h",
      "next: max-1, once its cache is cold",
    ])
    expect(colorOf(setup.app, "max-2")).toEqual(setup.theme.text.base.toInts())
  })

  test("after the chat's step, where it goes next as the new view says, the held one until then", async () => {
    const fake = pacerFake({ delay: 100 })
    fake.status = status("on")
    fake.chats[CHAT] = chat({ nextUse: { account: "max-1", reason: "cold_move" } })
    fake.accounts = accounts()
    await using setup = await renderPacer({
      fake,
      width: 40,
      height: 12,
      content: () => (
        <box width={37}>
          <PacerAccount sessionID={CHAT} />
        </box>
      ),
    })
    await setup.frame((frame) => frame.includes("next: max-1"))
    await setup.settle()
    const asks = () => fake.calls.filter((call) => call.method === "GET" && call.path === `chat/${CHAT}`).length
    const asked = asks()
    using recorder = recordFrames(setup.app)
    setup.emit({ type: "session.step.streamed", data: { sessionID: CHAT, assistantMessageID: "msg_next" } })
    await until(() => asks() === asked + 1, 5_000)
    setup.emit({
      type: "pacer.chat.updated",
      data: { chat: chat({ nextUse: { account: "max-3", reason: "cold_move" }, asOf: NOW + 1_000 }) },
    })
    await setup.frame((frame) => frame.includes("next: max-3"))
    await setup.settle()
    await Bun.sleep(50)
    await setup.app.renderOnce()
    expect(setup.app.captureCharFrame()).toContain("next: max-3")
    expect(recorder.missed).toBe(0)
    const nexts = recorder.frames.map((frame) => frame.text.match(/next: (max-\d)/)?.[1])
    expect(nexts.every((next) => next !== undefined)).toBe(true)
    const replaced = nexts.indexOf("max-3")
    expect(nexts.slice(replaced).every((next) => next === "max-3")).toBe(true)
  })

  test("a stale window, and one that turns stale while it shows", async () => {
    const stale = accounts()
    stale.items[0]!.windows[0]!.stale = true
    await using setup = await sidebar({ accounts: stale })
    await setup.frame((frame) => frame.includes("5h  62% left · resets 1:20 · stale"))
    expect(lines(setup.app.captureCharFrame())).toContain("7d  80% left · resets ~3d 4h")
    // Both readings turn stale an hour after they were read: the sidebar's clock marks them then.
    setup.clock.advance(3_600_000)
    const frame = await setup.frame((frame) => frame.includes("7d  80% left · resets ~3d 3h · stale"))
    expect(frame).toContain("5h  62% left · resets 0:20 · stale")
  })

  test("a forced move, now as a warning, or soon", async () => {
    {
      await using setup = await sidebar({ view: chat({ forceUse: { account: "max-1", when: "now" } }) })
      await setup.frame((frame) => frame.includes("forced move to max-1 now"))
      expect(colorOf(setup.app, "forced move to max-1 now")).toEqual(setup.theme.text.feedback.warning.base.toInts())
    }
    {
      await using setup = await sidebar({ view: chat({ forceUse: { account: "max-1", when: "soon" } }) })
      await setup.frame((frame) => frame.includes("forced move to max-1 soon"))
      expect(colorOf(setup.app, "forced move to max-1 soon")).toEqual(setup.theme.text.muted.toInts())
    }
  })

  test("greyed with as of while CPP is unreachable, and back in one frame once it answers again", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes("5h  62% left"))
    const current = styleOf(setup.app, "5h  62%")
    expect(current).toEqual({ fg: setup.theme.text.muted.toInts(), dim: false })
    setup.clock.advance(60_000)
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW + 60_000 }) } })
    const greyed = await setup.frame((frame) => frame.includes("as of 14:03"))
    // As CPP last said, at 14:03: the clock no longer runs.
    expect(lines(greyed)).toEqual([
      "Account",
      "max-2",
      "5h  62% left · resets 1:19",
      "7d  80% left · resets ~3d 3h",
      "as of 14:03",
    ])
    // Greyed: faint and dimmed, unlike the current lines also where the theme's faint text is its muted text.
    for (const text of ["max-2", "5h  62%", "7d  80%", "as of 14:03"])
      expect(styleOf(setup.app, text)).toEqual({ fg: setup.theme.text.faint.toInts(), dim: true })
    expect(styleOf(setup.app, "5h  62%")).not.toEqual(current)
    expect(setup.pacer.ticking()).toBe(false)
    // CPP comes back: the view is read again, and the section turns current when it is there.
    setup.fake.chats[CHAT] = chat({ account: "max-1" })
    setup.emit({ type: "pacer.status", data: { status: status("on", { since: NOW + 120_000 }) } })
    await setup.frame((frame) => frame.includes("max-1") && !frame.includes("as of"))
    expect(styleOf(setup.app, "max-1")).toEqual({ fg: setup.theme.text.base.toInts(), dim: false })
  })

  test("no pacer on a plain proxy", async () => {
    await using setup = await sidebar({ state: "no-pacer", view: null, accounts: null })
    const frame = await setup.frame((frame) => frame.includes("no pacer"))
    expect(lines(frame)).toEqual(["Account", "no pacer"])
  })

  test("hidden for a chat on another provider, and when no CPP is set up", async () => {
    for (const input of [{ providerID: "anthropic" }, { state: "unset" as const }]) {
      await using setup = await sidebar(input)
      await setup.settle()
      expect(lines(setup.app.captureCharFrame())).toEqual([])
      expect(setup.pacer.ticking()).toBe(false)
    }
  })

  test("hidden while CPP knows nothing of the chat", async () => {
    await using setup = await sidebar({ view: null })
    await setup.settle()
    expect(lines(setup.app.captureCharFrame())).toEqual([])
  })
})

test("Context is gone from the sidebar", () => {
  expect(builtins.map((plugin) => plugin.id)).not.toContain("opencode.sidebar.context")
  expect(existsSync(path.join(import.meta.dir, "../../src/feature-plugins/sidebar/context.tsx"))).toBe(false)
})
