/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { existsSync } from "node:fs"
import path from "node:path"
import { TextAttributes, type CapturedLine } from "@opentui/core"
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

/**
 * A line of the section as drawn: each cell's background as its meter tone (`S` a success fill, `W`, `E`, `M`, `T` the
 * track; lower case for the alternate row's tones; `.` none), and each non-blank cell's ink (`b` text, `m` muted, `s`
 * success, `i` info, `w` warning, `e` error; upper case in bold).
 */
function drawn(setup: Awaited<ReturnType<typeof sidebar>>, line: CapturedLine | undefined, width = 37) {
  const theme = setup.theme
  const meter = theme.background.meter
  const tones = (["success", "warning", "error", "muted", "track"] as const).flatMap((tone) => [
    [tone === "track" ? "T" : tone[0]!.toUpperCase(), meter[tone]] as const,
    [tone === "track" ? "t" : tone[0]!, meter.alternate[tone]] as const,
  ])
  const inks = [
    ["b", theme.text.base],
    ["m", theme.text.muted],
    ["s", theme.text.feedback.success.base],
    ["i", theme.text.feedback.info.base],
    ["w", theme.text.feedback.warning.base],
    ["e", theme.text.feedback.error.base],
  ] as const
  const cells = (line?.spans ?? []).flatMap((span) => Array.from(span.text, (character) => ({ character, span })))
  return {
    bg: cells
      .slice(0, width)
      .map(({ span }) => tones.find(([, color]) => color.equals(span.bg))?.[0] ?? ".")
      .join(""),
    ink: cells
      .slice(0, width)
      .map(({ character, span }) => {
        if (character === " ") return " "
        const ink = inks.find(([, color]) => color.equals(span.fg))?.[0] ?? "?"
        return (span.attributes & TextAttributes.BOLD) !== 0 ? ink.toUpperCase() : ink
      })
      .join("")
      .trimEnd(),
  }
}
const row = (setup: Awaited<ReturnType<typeof sidebar>>, index: number) =>
  drawn(setup, setup.app.captureSpans().lines[index])

// The fixture's accounts: max-2 of plan `max` with a 5h window (62% left, 1h 20m to its reset) and a 7d one (CPP's
// estimate), max-1 without a plan or a reading.
const TITLE = "Usage                     ● last used"
const HEAD = "Claude Max      5h                7d"
const ROW = "62%      1h 20m   80%      ~3d 4h"
const PLAIN = "Claude"
/** The row's backgrounds: 62% of 17 cells is 11 filled, 80.4% 14. */
const FILLS = "..SSSSSSSSSSSTTTTTT.SSSSSSSSSSSSSSTTT"

describe("the Usage section", () => {
  test("a group per plan, a row per account without its name, the chat's accounts marked, the legend", async () => {
    await using setup = await sidebar({ view: chat({ nextUse: { account: "max-1", reason: "cold_move" } }) })
    const frame = await setup.frame((frame) => frame.includes("› next"))
    expect(lines(frame)).toEqual([
      "Usage             ● last used  › next",
      HEAD,
      `●  ${ROW}`,
      PLAIN,
      "› no reading yet",
    ])
    const theme = setup.theme
    expect(styleOf(setup.app, "Claude Max")).toEqual({ fg: theme.text.base.toInts(), dim: false })
    expect(row(setup, 0)).toEqual({ bg: ".".repeat(37), ink: "BBBBB             i mmmm mmmm  i mmmm" })
    expect(row(setup, 1)).toEqual({ bg: ".".repeat(37), ink: "BBBBBB BBB      mm                mm" })
    expect(row(setup, 2)).toEqual({ bg: FILLS, ink: "I  BBB      bb bbb   BBB      bbb bb" })
    expect(row(setup, 4)).toEqual({ bg: ".".repeat(37), ink: "I mm mmmmmmm mmm" })
    // The tones the theme derives for the sidebar (spec section 6), under the percent and the time alike.
    expect(theme.background.meter.success.toInts()).toEqual([0x38, 0x57, 0x3e, 255])
    expect(theme.background.meter.track.toInts()).toEqual([0x1f, 0x1f, 0x1f, 255])
  })

  test("every other account's row in the alternate tones", async () => {
    const three = accounts()
    const strip = three.items[0]!
    three.items = ["max-2", "max-3", "max-4"].map((alias) => ({ ...strip, id: `login-${alias}`, alias }))
    await using setup = await sidebar({ view: null, accounts: three })
    await setup.frame((frame) => lines(frame).length === 5)
    expect([2, 3, 4].map((index) => row(setup, index).bg)).toEqual([FILLS, FILLS.toLowerCase(), FILLS])
    expect(setup.theme.background.meter.alternate.success.toInts()).toEqual([0x30, 0x47, 0x34, 255])
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
    const frame = await setup.frame((frame) => frame.includes("last used") && frame.includes("now"))
    expect(lines(frame)).toEqual([
      TITLE,
      HEAD,
      `●  ${ROW}`,
      "Claude          5h",
      "  no reading yet",
      "   100%        now",
    ])
    // The old login's reading: its reset passed, so muted, on the alternate row.
    expect(row(setup, 5)).toEqual({ bg: `..${"m".repeat(17)}${".".repeat(18)}`, ink: "   BBBB        bbb" })
  })

  test("a new reading changes a strip in one frame, the rest standing", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(ROW))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    const next = accounts()
    next.items[0]!.windows[0]!.left = 15
    setup.emit({ type: "pacer.accounts.updated", data: { accounts: next } })
    const after = "15%      1h 20m   80%      ~3d 4h"
    await setup.frame((frame) => frame.includes(after))
    // 15% left: 3 of 17 cells, in the warning tone, the percent in the warning color.
    expect(row(setup, 2)).toEqual({
      bg: "..WWWTTTTTTTTTTTTTT.SSSSSSSSSSSSSSTTT",
      ink: "I  WWW      bb bbb   BBB      bbb bb",
    })
    await setup.app.renderOnce()
    expect(recorder.missed).toBe(0)
    expect(recorder.frames.some((frame) => frame.text.includes(after))).toBe(true)
    for (const frame of recorder.frames) {
      expect(frame.text.includes(ROW) !== frame.text.includes(after)).toBe(true)
      expect(frame.text).toContain(HEAD)
      // The strip's text and its backgrounds change in the same frame.
      expect(drawn(setup, frame.lines[2]).bg).toBe(
        frame.text.includes(after) ? "..WWWTTTTTTTTTTTTTT.SSSSSSSSSSSSSSTTT" : FILLS,
      )
    }
  })

  test("a new chat, before CLIProxyPacer has served it: the accounts of the providers serving its model", async () => {
    await using setup = await sidebar({ view: null })
    const frame = await setup.frame((frame) => frame.includes(ROW))
    expect(lines(frame)).toEqual(["Usage", HEAD, `   ${ROW}`, PLAIN, "  no reading yet"])
  })

  test("switched to another model: its providers' accounts until CLIProxyPacer serves it", async () => {
    // The view is of the model the chat had: a codex model, served from a codex account.
    const codex = accounts()
    codex.items.push({ alias: "plus-1", provider: "codex", windows: [] })
    await using setup = await sidebar({
      view: chat({ model: "gpt-6-luna", provider: "codex", account: "plus-1" }),
      accounts: codex,
    })
    const frame = await setup.frame((frame) => frame.includes(ROW))
    expect(lines(frame)).toEqual(["Usage", HEAD, `   ${ROW}`, PLAIN, "  no reading yet"])
  })

  test("a model several providers serve: a group for each provider and plan", async () => {
    const mixed = accounts()
    mixed.items.push({ alias: "plus-1", provider: "codex", plan: "plus", windows: [] })
    mixed.items.push({ alias: "codex 376e36", provider: "codex", windows: [] })
    await using setup = await sidebar({
      view: null,
      accounts: mixed,
      models: { items: [{ id: "claude-opus-4-5", providers: ["claude", "codex"] }] },
    })
    const frame = await setup.frame((frame) => frame.includes("Codex Plus"))
    expect(lines(frame)).toEqual([
      "Usage",
      HEAD,
      `   ${ROW}`,
      PLAIN,
      "  no reading yet",
      "Codex Plus",
      "  no reading yet",
      "Codex",
      "  no reading yet",
    ])
  })

  // The owner, 2026-11-08: "If that same model is used, but from a different provider (command code haiku for
  // example), you see only those", of the accounts "that has that model available".
  test("a provider only some of whose accounts serve the model: the chat's own, not the others", async () => {
    const commandcode = accounts()
    commandcode.items.push(
      {
        id: "login-goat",
        alias: "commandcode 95c614",
        provider: "commandcode",
        plan: "individual-goat",
        windows: [{ ...commandcode.items[0]!.windows[0]! }],
      },
      {
        id: "key-1",
        alias: "commandcode-apikey",
        provider: "commandcode",
        windows: [commandcode.items[0]!.windows[0]!],
      },
    )
    await using setup = await sidebar({
      model: "commandcode/claude-opus-4-5",
      view: chat({ provider: "commandcode", account: "commandcode-apikey", accountID: "key-1" }),
      accounts: commandcode,
      models: {
        items: [{ id: "commandcode/claude-opus-4-5", providers: ["commandcode"], partial: ["commandcode"] }],
      },
    })
    const frame = await setup.frame((frame) => frame.includes("Command Code"))
    expect(lines(frame)).toEqual([TITLE, "Command Code    5h", "●  62%      1h 20m"])
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
    await setup.frame((frame) => frame.includes("● last used"))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    setup.setModel("gpt-6-luna")
    await setup.frame((frame) => frame.includes("Codex"))
    expect(lines(setup.app.captureCharFrame())).toEqual(["Usage", "Codex", "  no reading yet"])
    // Another provider's model: the section goes.
    setup.setModel(undefined)
    await setup.frame((frame) => lines(frame).length === 0)
    setup.setModel("claude-opus-4-5")
    await setup.frame((frame) => frame.includes("● last used"))
    await setup.app.renderOnce()
    expect(recorder.missed).toBe(0)
    const states = [
      (frame: string) => frame.includes(`●  ${ROW}`) && frame.includes(TITLE) && !frame.includes("Codex"),
      (frame: string) => frame.includes("Codex") && !frame.includes("Claude"),
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
    const frame = await setup.frame((frame) => frame.includes(ROW))
    expect(lines(frame)).toEqual(["Usage", HEAD, `   ${ROW}`, PLAIN, "  no reading yet"])
  })

  // Issue 3 of the same run: the account of a chat's first step was known only once the step ended.
  test("in use on the chat's first step, read once CLIProxyPacer has routed it", async () => {
    await using setup = await sidebar({ view: null })
    await setup.frame((frame) => frame.includes(ROW))
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
    await setup.frame((frame) => frame.includes(`●  ${ROW}`) && frame.includes("● in use"))
    expect(reads()).toBe(before + 1)
    // Once an account is held, a step start reads nothing; the step's end does, as before.
    started("req_second")
    await setup.settle()
    expect(reads()).toBe(before + 1)
  })

  test("in use while the chat's step runs on its account, in the success color", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes("● last used"))
    setup.emit({
      type: "session.execution.started",
      durable: { aggregateID: CHAT, seq: 0, version: 1 },
      data: { sessionID: CHAT },
    })
    const frame = await setup.frame((frame) => frame.includes("● in use"))
    expect(lines(frame)[0]).toBe("Usage                        ● in use")
    expect(row(setup, 0).ink).toBe("BBBBB                        s mm mmm")
    expect(row(setup, 2).ink).toBe("S  BBB      bb bbb   BBB      bbb bb")
  })

  test("a forced move's account, marked » as a warning", async () => {
    await using setup = await sidebar({ view: chat({ forceUse: { account: "max-1", when: "now" } }) })
    const frame = await setup.frame((frame) => frame.includes("» forced"))
    expect(lines(frame)[0]).toBe("Usage           ● last used  » forced")
    expect(lines(frame).at(-1)).toBe("» no reading yet")
    expect(colorOf(setup.app, "»")).toEqual(setup.theme.text.feedback.warning.base.toInts())
  })

  test("a minute passing changes only the time's digits; a reading turning stale mutes its fill", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(ROW))
    await setup.settle()
    using recorder = recordFrames(setup.app)
    // 1h 20m to the 5h window's reset, minutes rounded up: still so 30 s on, 1h 19m at the minute.
    setup.clock.advance(30_000)
    await setup.settle()
    expect(setup.app.captureCharFrame()).toContain(ROW)
    setup.clock.advance(30_000)
    const later = "62%      1h 19m   80%      ~3d 3h"
    await setup.frame((frame) => frame.includes(later))
    await setup.app.renderOnce()
    expect(recorder.missed).toBe(0)
    const before = lines(recorder.frames[0]!.text)
    for (const frame of recorder.frames) {
      const now = lines(frame.text)
      expect(now.filter((line, index) => line !== before[index])).toEqual(
        now.includes(`●  ${later}`) ? [`●  ${later}`] : [],
      )
      expect(drawn(setup, frame.lines[2]).bg).toBe(FILLS)
    }
    // Both readings turn stale an hour after they were read: their times stand, their fills mute, the percent stays.
    setup.clock.advance(59 * 60_000)
    await setup.frame((frame) => frame.includes("62%         20m   80%      ~3d 3h"))
    await until(() => row(setup, 2).bg === "..MMMMMMMMMMMTTTTTT.MMMMMMMMMMMMMMTTT", 5_000)
    expect(row(setup, 2).ink).toBe("I  BBB         bbb   BBB      bbb bb")
  })

  test("greyed with as of on its title line while CPP is unreachable, and back in one frame once it answers", async () => {
    await using setup = await sidebar({})
    await setup.frame((frame) => frame.includes(ROW))
    setup.clock.advance(60_000)
    setup.emit({ type: "pacer.status", data: { status: status("unreachable", { asOf: NOW + 60_000 }) } })
    const greyed = await setup.frame((frame) => frame.includes("as of 14:03"))
    // As CPP last said, at 14:03: the clock no longer runs.
    expect(lines(greyed)).toEqual([
      "Usage                     as of 14:03",
      HEAD,
      "●  62%      1h 19m   80%      ~3d 3h",
      PLAIN,
      "  no reading yet",
    ])
    for (const text of ["Usage", "Claude Max", "●", "62%", "19m", "~3d", "as of 14:03"])
      expect([text, styleOf(setup.app, text)]).toEqual([text, { fg: setup.theme.text.faint.toInts(), dim: true }])
    expect(row(setup, 2).bg).toBe("..MMMMMMMMMMMTTTTTT.MMMMMMMMMMMMMMTTT")
    expect(setup.pacer.ticking()).toBe(false)
    // CPP comes back: the view is read again, and the section turns current when it is there.
    setup.fake.chats[CHAT] = chat({ account: "max-1" })
    setup.emit({ type: "pacer.status", data: { status: status("on", { since: NOW + 120_000 }) } })
    await setup.frame((frame) => frame.includes("● no reading yet") && !frame.includes("as of"))
    expect(styleOf(setup.app, "Claude Max")).toEqual({ fg: setup.theme.text.base.toInts(), dim: false })
    expect(row(setup, 2).bg).toBe(FILLS)
  })

  test("a narrower section: the strips narrow, the times in one unit", async () => {
    const fake = pacerFake()
    fake.status = status("on")
    fake.chats[CHAT] = chat()
    fake.accounts = accounts()
    fake.models = MODELS
    await using setup = await renderPacer({
      fake,
      width: 40,
      height: 16,
      sessions: { [CHAT]: { providerID: "cliproxypacer" } },
      content: () => (
        <box width={30}>
          <PacerUsage sessionID={CHAT} model="claude-opus-4-5" />
        </box>
      ),
    })
    // Laid out at the sidebar's 37 until the section has measured its 30.
    const frame = await setup.frame((frame) => frame.includes("Claude Max  5h"))
    expect(lines(frame).slice(0, 3)).toEqual([
      "Usage              ● last used",
      "Claude Max  5h            7d",
      "●  62%      1h   80%     ~3d",
    ])
    expect(lines(frame).every((line) => line.length <= 30)).toBe(true)
  })

  test("no pacer at the title line's end on a plain proxy", async () => {
    await using setup = await sidebar({ state: "no-pacer", view: null, accounts: null, models: null })
    const frame = await setup.frame((frame) => frame.includes("no pacer"))
    expect(lines(frame)).toEqual(["Usage                        no pacer"])
    expect(colorOf(setup.app, "no pacer")).toEqual(setup.theme.text.muted.toInts())
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
  await setup.frame((frame) => frame.includes(ROW))
})

test("back on a chat, 20 accounts of 4 windows are on screen in full within 100 ms, on every frame", async () => {
  // Four windows that limit the chat's model: three strips on an account's first line, the fourth on its second.
  const labels = ["5h", "7d", "30d", "7d opus"]
  const many: PacerAccounts = {
    asOf: NOW,
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `login-${index}`,
      alias: `acct-${String(index + 1).padStart(2, "0")}`,
      provider: "claude",
      windows: labels.map((label, at) => ({
        label,
        scope: label.split(" ")[1] ?? "all",
        seconds: label.startsWith("5h") ? 18_000 : label.startsWith("30d") ? 2_592_000 : 604_800,
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
  // The title with the legend, the group's name with three labels, the fourth label, two lines per account.
  const full = (frame: string) => frame.includes("● last used") && lines(frame).length === 43
  const none = (frame: string) => lines(frame).length === 0
  await setup.frame(full)
  expect(lines(setup.app.captureCharFrame()).slice(0, 3)).toEqual([
    "Usage                     ● last used",
    "Claude    5h          7d         30d",
    "     opus 7d",
  ])
  setup.route.navigate({ type: "session", sessionID: OTHER })
  await setup.frame(none)
  await setup.settle()
  // A far CPP: nothing it answers now is on screen in time.
  fake.delay = 300
  using recorder = recordFrames(setup.app)
  const start = performance.now()
  setup.route.navigate({ type: "session", sessionID: CHAT })
  await setup.frame(full)
  const drawnAt = recorder.frames.find((frame) => full(frame.text))!
  console.log(`Usage: 20 accounts of 4 windows on screen ${(drawnAt.at - start).toFixed(1)} ms after the switch`)
  expect(drawnAt.at - start).toBeLessThan(100)
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
