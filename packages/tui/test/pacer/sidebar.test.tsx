/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { existsSync } from "node:fs"
import path from "node:path"
import type { PacerAccounts, PacerModels } from "@opencode/client"
import { useRoute } from "../../src/context/route"
import { PacerUsage } from "../../src/pacer/usage"
import { builtins } from "../../src/plugin/builtins"
import { recordFrames } from "../fixture/frames"
import { until } from "../fixture/wait"
import { accounts, CHAT, chat, colorOf, NOW, pacerFake, renderPacer, status, styleOf } from "./fixture"

// Spec cliproxypacer-usage-meters: the sidebar's Usage section, where step 1's Account section was.

const MODELS: PacerModels = { items: [{ id: "claude-opus-4-5", providers: ["claude"] }] }

async function sidebar(input: {
  state?: Parameters<typeof status>[0]
  view?: ReturnType<typeof chat> | null
  accounts?: PacerAccounts | null
  models?: PacerModels | null
  providerID?: string
  /** CPP's model picked for the chat in the prompt; null for another provider's. */
  model?: string | null
}) {
  const [model, setModel] = createSignal<string | undefined>(
    input.model === null ? undefined : (input.model ?? "claude-opus-4-5"),
  )
  const fake = pacerFake()
  fake.status = status(input.state ?? "on")
  if (input.view !== null) fake.chats[CHAT] = input.view ?? chat()
  fake.accounts = input.accounts === undefined ? accounts() : input.accounts
  fake.models = input.models === undefined ? MODELS : input.models
  const setup = await renderPacer({
    fake,
    width: 40,
    height: 16,
    sessions: { [CHAT]: { providerID: input.providerID ?? "cliproxypacer" } },
    content: () => (
      <box width={37}>
        <PacerUsage sessionID={CHAT} model={model()} />
      </box>
    ),
  })
  return { ...setup, fake, setModel }
}

const lines = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

const FIVE = "5h ████████████░░░░░░░░  62%  1h 20m"
const SEVEN = "7d ████████████████░░░░  80%  ~3d 4h"

describe("the Usage section", () => {
  test("every account of the serving account's provider, each window a meter, the chat's accounts tagged", async () => {
    await using setup = await sidebar({ view: chat({ nextUse: { account: "max-1", reason: "cold_move" } }) })
    const frame = await setup.frame((frame) => frame.includes("7d") && frame.includes("NEXT USE"))
    expect(lines(frame)).toEqual([
      "Usage",
      "max-1 · NEXT USE",
      "No quota reading yet.",
      "max-2 · LAST USED",
      FIVE,
      SEVEN,
    ])
    const theme = setup.theme
    expect(colorOf(setup.app, "max-2")).toEqual(theme.text.base.toInts())
    expect(colorOf(setup.app, "LAST USED")).toEqual(theme.text.feedback.info.base.toInts())
    expect(colorOf(setup.app, "NEXT USE")).toEqual(theme.text.feedback.info.base.toInts())
    expect(colorOf(setup.app, "████████████")).toEqual(theme.text.feedback.success.base.toInts())
    expect(colorOf(setup.app, "░░░░░░░░")).toEqual(theme.text.muted.toInts())
  })

  test("of two logins of one address, which CPP names alike, the one serving the chat by its ID", async () => {
    // As the owner's CPP listed them on 2026-11-06 (run/evidence/v0.0.7/live-owner-3): the first login read hours ago,
    // the second serving the chat and current.
    const both = accounts({ id: "login-current" })
    const old = {
      id: "login-old",
      alias: "max-2",
      provider: "claude",
      windows: [
        {
          label: "5h",
          scope: "all",
          seconds: 18_000,
          left: 100,
          readAt: NOW - 5 * 3_600_000,
          state: "awaiting-confirmation" as const,
          stale: true,
          staleAt: NOW - 4 * 3_600_000,
        },
      ],
    }
    await using setup = await sidebar({
      view: chat({ accountID: "login-current" }),
      accounts: { ...both, items: [old, ...both.items] },
    })
    const frame = await setup.frame((frame) => frame.includes("LAST USED") && frame.includes("7d"))
    expect(lines(frame)).toEqual([
      "Usage",
      "max-1",
      "No quota reading yet.",
      "max-2",
      "5h ████████████████████ 100%   reset",
      "max-2 · LAST USED",
      FIVE,
      SEVEN,
    ])
    expect(colorOf(setup.app, "████████████████████")).toEqual(setup.theme.text.muted.toInts())
  })

  test("a new reading changes a bar in one frame, the rest standing", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(FIVE))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    const next = accounts()
    next.items[0]!.windows[0]!.left = 15
    setup.emit({ type: "pacer.accounts.updated", data: { accounts: next } })
    const after = "5h ███░░░░░░░░░░░░░░░░░  15%  1h 20m"
    await setup.frame((frame) => frame.includes(after))
    // The first bar's filled cells.
    expect(colorOf(setup.app, "███")).toEqual(setup.theme.text.feedback.warning.base.toInts())
    await setup.app.renderOnce()
    expect(recorder.missed).toBe(0)
    expect(recorder.frames.some((frame) => frame.text.includes(after))).toBe(true)
    for (const frame of recorder.frames) {
      expect(frame.text.includes(FIVE) !== frame.text.includes(after)).toBe(true)
      expect(frame.text).toContain(SEVEN)
    }
  })

  test("a new chat, before CLIProxyPacer has served it: every account of the providers serving its model", async () => {
    await using setup = await sidebar({ view: null })
    const frame = await setup.frame((frame) => frame.includes("7d"))
    expect(lines(frame)).toEqual(["Usage", "max-1", "No quota reading yet.", "max-2", FIVE, SEVEN])
  })

  test("switched to another model: its providers' accounts until CLIProxyPacer serves it", async () => {
    // The view is of the model the chat had: a codex model, served from a codex account.
    const codex = accounts()
    codex.items.push({ alias: "plus-1", provider: "codex", windows: [] })
    await using setup = await sidebar({
      view: chat({ model: "gpt-6-luna", provider: "codex", account: "plus-1" }),
      accounts: codex,
    })
    const frame = await setup.frame((frame) => frame.includes("7d"))
    expect(lines(frame)).toEqual(["Usage", "max-1", "No quota reading yet.", "max-2", FIVE, SEVEN])
  })

  test("a model several providers serve: each account names its provider, unless its alias does", async () => {
    const mixed = accounts()
    mixed.items.push({ alias: "plus-1", provider: "codex", windows: [] })
    mixed.items.push({ alias: "codex 376e36", provider: "codex", windows: [] })
    await using setup = await sidebar({
      view: null,
      accounts: mixed,
      models: { items: [{ id: "claude-opus-4-5", providers: ["claude", "codex"] }] },
    })
    const frame = await setup.frame((frame) => frame.includes("plus-1"))
    expect(lines(frame)).toEqual([
      "Usage",
      "max-1 · claude",
      "No quota reading yet.",
      "max-2 · claude",
      FIVE,
      SEVEN,
      "codex 376e36",
      "No quota reading yet.",
      "plus-1 · codex",
      "No quota reading yet.",
    ])
    expect(colorOf(setup.app, " · codex")).toEqual(setup.theme.text.muted.toInts())
  })

  // Found live on 2026-11-08 (run/evidence/cpp-usage-meters/live-1, issue 2): the section followed the chat's saved
  // model, so a model picked in the prompt showed only once sent.
  test("follows the model picked for the chat before it is sent, in one frame", async () => {
    const codex = accounts()
    codex.items.push({ alias: "plus-1", provider: "codex", windows: [] })
    await using setup = await sidebar({
      accounts: codex,
      models: { items: [...MODELS.items, { id: "gpt-6-luna", providers: ["codex"] }] },
    })
    await setup.frame((frame) => frame.includes("max-2 · LAST USED"))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    setup.setModel("gpt-6-luna")
    await setup.frame((frame) => frame.includes("plus-1"))
    expect(lines(setup.app.captureCharFrame())).toEqual(["Usage", "plus-1", "No quota reading yet."])
    // Another provider's model: the section goes.
    setup.setModel(undefined)
    await setup.frame((frame) => lines(frame).length === 0)
    setup.setModel("claude-opus-4-5")
    await setup.frame((frame) => frame.includes("max-2 · LAST USED"))
    await setup.app.renderOnce()
    expect(recorder.missed).toBe(0)
    const states = [
      (frame: string) => frame.includes("max-2 · LAST USED") && frame.includes(SEVEN) && !frame.includes("plus-1"),
      (frame: string) => frame.includes("plus-1") && !frame.includes("max-"),
      (frame: string) => lines(frame).length === 0,
    ]
    expect(
      recorder.frames.filter((frame) => !states.some((state) => state(frame.text))).map((frame) => frame.text),
    ).toEqual([])
  })

  // Issue 1 of the same run: switched without a step, CPP's view names the new model and keeps the old account.
  test("switched to a model the chat's account doesn't serve: the new model's accounts", async () => {
    const codex = accounts()
    codex.items.push({ id: "login-plus", alias: "plus-1", provider: "codex", windows: [] })
    await using setup = await sidebar({
      view: chat({ model: "claude-opus-4-5", provider: "codex", account: "plus-1", accountID: "login-plus" }),
      accounts: codex,
    })
    const frame = await setup.frame((frame) => frame.includes("7d"))
    expect(lines(frame)).toEqual(["Usage", "max-1", "No quota reading yet.", "max-2", FIVE, SEVEN])
  })

  // Issue 3 of the same run: the account of a chat's first step was known only once the step ended.
  test("IN USE on the chat's first step, read once CLIProxyPacer has routed it", async () => {
    await using setup = await sidebar({ view: null })
    await setup.frame((frame) => frame.includes(SEVEN))
    await setup.settle()
    const reads = () => setup.fake.calls.filter((call) => call.path === `chat/${CHAT}`).length
    const before = reads()
    setup.fake.chats[CHAT] = chat()
    setup.emit({
      type: "session.execution.started",
      durable: { aggregateID: CHAT, seq: 0, version: 1 },
      data: { sessionID: CHAT },
    })
    const started = (proxyRequestID?: string) =>
      setup.emit({
        type: "session.step.started",
        durable: { aggregateID: CHAT, seq: 1, version: 1 },
        data: {
          sessionID: CHAT,
          assistantMessageID: "msg_first",
          agent: "build",
          model: { providerID: "cliproxypacer", id: "claude-opus-4-5" },
          started: NOW,
          ...(proxyRequestID ? { proxyRequestID } : {}),
        },
      })
    // Before CPP's answer named the request, CPP may not have routed it: nothing is read.
    started()
    await setup.settle()
    expect(reads()).toBe(before)
    started("req_first")
    await setup.frame((frame) => frame.includes("max-2 · IN USE"))
    expect(reads()).toBe(before + 1)
    // Once an account is held, a step start reads nothing; the step's end does, as before.
    started("req_second")
    await setup.settle()
    expect(reads()).toBe(before + 1)
  })

  test("IN USE while the chat's step runs on its account", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes("max-2 · LAST USED"))
    setup.emit({
      type: "session.execution.started",
      durable: { aggregateID: CHAT, seq: 0, version: 1 },
      data: { sessionID: CHAT },
    })
    await setup.frame((frame) => frame.includes("max-2 · IN USE"))
    expect(colorOf(setup.app, "IN USE")).toEqual(setup.theme.text.feedback.success.base.toInts())
  })

  test("FORCE USE where a forced move sends the chat, as a warning", async () => {
    await using setup = await sidebar({ view: chat({ forceUse: { account: "max-1", when: "now" } }) })
    await setup.frame((frame) => frame.includes("max-1 · FORCE USE"))
    expect(colorOf(setup.app, "FORCE USE")).toEqual(setup.theme.text.feedback.warning.base.toInts())
  })

  test("a long alias is cut, never a tag", async () => {
    const long = accounts({ alias: "a-very-long-account-alias-of-many-cells" })
    await using setup = await sidebar({
      view: chat({
        account: "a-very-long-account-alias-of-many-cells",
        nextUse: { account: "a-very-long-account-alias-of-many-cells", reason: "cold_move" },
      }),
      accounts: long,
    })
    const frame = await setup.frame((frame) => frame.includes("LAST USED · NEXT USE"))
    const head = lines(frame).find((line) => line.includes("LAST USED"))!
    // OpenTUI cuts it in the middle.
    expect(head).toMatch(/^a-ver.*\.\.\..*-cells · LAST USED · NEXT USE$/)
    expect(head.length).toBeLessThanOrEqual(37)
  })

  test("a minute on, only the digits change; a stale reading and one turning stale say STALE", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(FIVE))
    setup.clock.advance(60_000)
    await setup.frame((frame) => frame.includes("5h ████████████░░░░░░░░  62%  1h 19m"))
    // Both readings turn stale an hour after they were read.
    setup.clock.advance(59 * 60_000)
    const frame = await setup.frame((frame) => frame.includes("STALE"))
    expect(lines(frame).slice(-2)).toEqual([
      "5h ████████████░░░░░░░░  62%   STALE",
      "7d ████████████████░░░░  80%   STALE",
    ])
    expect(colorOf(setup.app, "████████████████")).toEqual(setup.theme.text.muted.toInts())
  })

  test("greyed with as of while CPP is unreachable, and back in one frame once it answers again", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(FIVE))
    setup.clock.advance(60_000)
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW + 60_000 }) } })
    const greyed = await setup.frame((frame) => frame.includes("as of 14:03"))
    // As CPP last said, at 14:03: the clock no longer runs.
    expect(lines(greyed)).toEqual([
      "Usage",
      "max-1",
      "No quota reading yet.",
      "max-2 · LAST USED",
      "5h ████████████░░░░░░░░  62%  1h 19m",
      "7d ████████████████░░░░  80%  ~3d 3h",
      "as of 14:03",
    ])
    for (const text of ["max-2", "LAST USED", "62%", "1h 19m", "as of 14:03"])
      expect(styleOf(setup.app, text)).toEqual({ fg: setup.theme.text.faint.toInts(), dim: true })
    expect(setup.pacer.ticking()).toBe(false)
    // CPP comes back: the view is read again, and the section turns current when it is there.
    setup.fake.chats[CHAT] = chat({ account: "max-1" })
    setup.emit({ type: "pacer.status", data: { status: status("on", { since: NOW + 120_000 }) } })
    await setup.frame((frame) => frame.includes("max-1 · LAST USED") && !frame.includes("as of"))
    expect(styleOf(setup.app, "max-1")).toEqual({ fg: setup.theme.text.base.toInts(), dim: false })
  })

  test("no pacer on a plain proxy", async () => {
    await using setup = await sidebar({ state: "no-pacer", view: null, accounts: null, models: null })
    const frame = await setup.frame((frame) => frame.includes("no pacer"))
    expect(lines(frame)).toEqual(["Usage", "no pacer"])
  })

  test("hidden while another provider's model is picked for the chat, and when no CPP is set up", async () => {
    for (const input of [{ providerID: "anthropic", model: null }, { state: "unset" as const }]) {
      await using setup = await sidebar(input)
      await setup.settle()
      expect(lines(setup.app.captureCharFrame())).toEqual([])
      expect(setup.pacer.ticking()).toBe(false)
    }
  })

  test("hidden while no account of the model's providers is known", async () => {
    await using setup = await sidebar({ view: null, models: null })
    await setup.settle()
    expect(lines(setup.app.captureCharFrame())).toEqual([])
  })
})

test("Context and the Account section are gone from the sidebar", () => {
  expect(builtins.map((plugin) => plugin.id)).not.toContain("opencode.sidebar.context")
  expect(existsSync(path.join(import.meta.dir, "../../src/feature-plugins/sidebar/context.tsx"))).toBe(false)
  expect(existsSync(path.join(import.meta.dir, "../../src/pacer/account.tsx"))).toBe(false)
})

test("the section reads the providers serving each model once CPP is set up, and follows their changes", async () => {
  await using setup = await sidebar({ view: null, models: { items: [] } })
  await until(() => setup.fake.calls.some((call) => call.path === "models"), 5_000)
  await setup.settle()
  expect(lines(setup.app.captureCharFrame())).toEqual([])
  setup.emit({ type: "pacer.models.updated", data: { models: MODELS } })
  await setup.frame((frame) => frame.includes(FIVE))
})

test("back on a chat, 20 accounts of 4 windows are on screen in full within 100 ms, on every frame", async () => {
  const labels = ["5h", "7d", "7d opus", "7d sonnet"]
  const many: PacerAccounts = {
    asOf: NOW,
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `login-${index}`,
      alias: `acct-${String(index + 1).padStart(2, "0")}`,
      provider: "claude",
      windows: labels.map((label, at) => ({
        label,
        scope: label.split(" ")[1] ?? "all",
        seconds: label.startsWith("5h") ? 18_000 : 604_800,
        left: (index * 7 + at * 13) % 101,
        resetsAt: NOW + (at + 1) * 3_600_000,
        readAt: NOW,
        state: "current" as const,
        stale: false,
        staleAt: NOW + 3_600_000,
      })),
    })),
  }
  const fake = pacerFake()
  fake.status = status("on")
  fake.accounts = many
  fake.models = MODELS
  fake.chats[CHAT] = chat({ account: "acct-07", accountID: "login-6" })
  const OTHER = "ses_other"
  await using setup = await renderPacer({
    fake,
    width: 40,
    height: 110,
    sessions: { [CHAT]: { providerID: "cliproxypacer" }, [OTHER]: { providerID: "anthropic" } },
    content: () => (
      <box width={37}>
        <Shown />
      </box>
    ),
  })
  const full = (frame: string) =>
    frame.includes("acct-07 · LAST USED") && frame.includes("acct-20") && lines(frame).length === 101
  const none = (frame: string) => lines(frame).length === 0
  await setup.frame(full)
  setup.route.navigate({ type: "session", sessionID: OTHER })
  await setup.frame(none)
  await setup.settle()
  // A far CPP: nothing it answers now is on screen in time.
  fake.delay = 300
  using recorder = recordFrames(setup.app)
  const start = performance.now()
  setup.route.navigate({ type: "session", sessionID: CHAT })
  await setup.frame(full)
  const drawn = recorder.frames.find((frame) => full(frame.text))!
  console.log(`Usage: 20 accounts of 4 windows on screen ${(drawn.at - start).toFixed(1)} ms after the switch`)
  expect(drawn.at - start).toBeLessThan(100)
  expect(recorder.missed).toBe(0)
  expect(recorder.frames.filter((frame) => !full(frame.text) && !none(frame.text)).map((frame) => frame.text)).toEqual(
    [],
  )
})

/** The section of the chat the route shows, with the model picked for it, as the sidebar mounts it: CPP's for CHAT. */
function Shown() {
  const route = useRoute()
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : CHAT)
  return <PacerUsage sessionID={sessionID()} model={sessionID() === CHAT ? "claude-opus-4-5" : undefined} />
}
