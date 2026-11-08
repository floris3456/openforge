import { describe, expect, test } from "bun:test"
import type { PacerAccount, PacerRequest, PacerWindow } from "@opencode/client"
import { promptless } from "@opencode/schema/pacer"
import { mergeFirst } from "../../src/context/pacer"
import {
  cacheLabel,
  cacheText,
  chatAccount,
  formatRemaining,
  formatTokens,
  noticeAge,
  noticesMore,
  noticesShown,
  noticeSubject,
  noticeTitle,
  remainingHours,
  promptChangeLines,
  promptlessLines,
  requestHeader,
  requestLayout,
  requestRow,
  requestTone,
  usageAccounts,
  usageCountdown,
  usageLabelWidth,
  usageLine,
  usageMeter,
  usageTags,
} from "../../src/pacer/format"
import { requestTarget } from "../../src/pacer/jump"
import { listTop } from "../../src/routes/session/composer/requests-tab"
import { chat, miss, notice, NOW, promptChange, request, step, webCall } from "./fixture"

// Written from spec cliproxypacer-step-1: section 4's table and section 7's rows, Enter and what changed; and from
// spec cliproxypacer-usage-meters, which replaced step 1's section 5.

describe("the toolbar's cache item (section 4)", () => {
  const text = (view: Parameters<typeof cacheLabel>[0], now = NOW) => {
    const label = cacheLabel(view, now)
    return { text: cacheText(label, now), tone: label.tone }
  }

  test("pings run: warm, counting down to when the cache goes cold with the pings planned", () => {
    // coldAt is warm_until plus the pings left times the interval; it is what the item counts down to.
    expect(text(chat())).toEqual({ text: "warm 23:41", tone: "muted" })
    expect(cacheLabel(chat(), NOW).until).toBe(chat().coldAt)
  })

  test("warming off for the chat, the cache still warm", () => {
    const view = chat({
      switches: { warming: false, compactBeforeCold: false, compactColdFirst: false },
      pings: { active: false, left: 0, sent: 0, failed: false, stopped: "off" },
      coldAt: NOW + 3 * 60_000 + 12_000,
    })
    expect(text(view)).toEqual({ text: "warming off · warm 3:12", tone: "muted" })
  })

  test("the cache went cold, as a warning", () => {
    expect(text(chat({ warm: false }))).toEqual({ text: "cache cold", tone: "warning" })
    // Also once the countdown reaches its end before CPP says so.
    expect(text(chat(), chat().coldAt! + 1)).toEqual({ text: "cache cold", tone: "warning" })
  })

  test("pings stopped on a failure, as a warning", () => {
    for (const stopped of ["cold", "account_changed", "unauthorized", "floored"]) {
      const view = chat({
        pings: { active: false, left: 0, sent: 2, failed: true, stopped },
        coldAt: NOW + 2 * 60_000 + 10_000,
      })
      expect(text(view)).toEqual({ text: "keep-alive stopped · warm 2:10", tone: "warning" })
    }
  })

  test("compact before cold is on and due", () => {
    const view = chat({
      switches: { warming: true, compactBeforeCold: true, compactColdFirst: false },
      compactAt: new Date(2026, 10, 6, 14, 32).getTime(),
      compactReason: "before-cold",
    })
    expect(text(view)).toEqual({ text: "compacts at 14:32", tone: "muted" })
    // On, but not due: the countdown.
    expect(text(chat({ switches: { warming: true, compactBeforeCold: true, compactColdFirst: false } })).text).toBe(
      "warm 23:41",
    )
  })

  // Spec cliproxypacer-cold-ask, section 3; openforge acts on CPP's ask only with automatic compaction on, which its
  // newest step announced (`coldAskAnnounced`, the lead's fix of 2026-11-07).
  test("the cache went cold, the chat's compact cold chats first on and it at least as large as the threshold", () => {
    const switches = { warming: true, compactBeforeCold: false, compactColdFirst: true }
    const size = { tokens: 80_000, threshold: 70_000 }
    const announced = { switches, coldAskAnnounced: true }
    expect(text(chat({ warm: false, size, ...announced }))).toEqual({
      text: "cache cold · compacts first",
      tone: "warning",
    })
    // As large as the threshold is enough; so is the countdown reaching its end before CPP says the cache is cold.
    expect(text(chat({ warm: false, size: { tokens: 70_000, threshold: 70_000 }, ...announced })).text).toBe(
      "cache cold · compacts first",
    )
    expect(text(chat({ size, ...announced }), chat().coldAt! + 1).text).toBe("cache cold · compacts first")
    // Smaller than the threshold, no size, or the switch off: only cold.
    expect(text(chat({ warm: false, size: { tokens: 69_999, threshold: 70_000 }, ...announced })).text).toBe(
      "cache cold",
    )
    expect(text(chat({ warm: false, ...announced })).text).toBe("cache cold")
    expect(text(chat({ warm: false, size, coldAskAnnounced: true })).text).toBe("cache cold")
    // Still warm: the countdown, whatever the size.
    expect(text(chat({ size, ...announced })).text).toBe("warm 23:41")
  })

  test("a cold chat compacts first only when its newest step announced the cold ask (automatic compaction on)", () => {
    const switches = { warming: true, compactBeforeCold: false, compactColdFirst: true }
    const size = { tokens: 80_000, threshold: 70_000 }
    expect(text(chat({ warm: false, switches, size, coldAskAnnounced: false })).text).toBe("cache cold")
    // CPP didn't say: nothing tells that openforge would act on it.
    expect(text(chat({ warm: false, switches, size })).text).toBe("cache cold")
    expect(text(chat({ warm: false, switches, size, coldAskAnnounced: true })).text).toBe("cache cold · compacts first")
  })

  test("the account can't serve the next step, as a warning", () => {
    const view = chat({ forceUse: { account: "max-1", when: "now" } })
    expect(text(view)).toEqual({ text: "account used up · next step moves to max-1", tone: "warning" })
    // A move soon leaves the toolbar as it is; the sidebar says it.
    expect(text(chat({ forceUse: { account: "max-1", when: "soon" } })).text).toBe("warm 23:41")
  })

  test("countdowns", () => {
    expect(formatRemaining(65 * 60_000 + 9_000)).toBe("1:05:09")
    expect(formatRemaining(23 * 60_000 + 41_000)).toBe("23:41")
    expect(formatRemaining(7_000)).toBe("0:07")
    expect(formatRemaining(10 * 60_000)).toBe("10:00")
    expect(formatRemaining(10 * 60_000 - 1)).toBe("10:00")
    expect(formatRemaining(10 * 60_000 - 1000)).toBe("9:59")
    expect(formatRemaining(-5)).toBe("0:00")
    // One that started at an hour or more keeps its hours down to the end; an hour shows as one, rounded up.
    expect(formatRemaining(3_600_000, true)).toBe("1:00:00")
    expect(formatRemaining(3_600_000 - 1000, true)).toBe("0:59:59")
    expect(formatRemaining(7_000, true)).toBe("0:00:07")
    expect(formatRemaining(0, true)).toBe("0:00:00")
    expect(remainingHours(3_600_000 - 999)).toBe(true)
    expect(remainingHours(3_600_000 - 1000)).toBe(false)
  })
})

describe("the sidebar's usage meters (spec cliproxypacer-usage-meters)", () => {
  const window = (extra: Partial<PacerWindow>): PacerWindow => ({
    label: "5h",
    scope: "all",
    seconds: 18_000,
    left: 62,
    resetsAt: NOW + 80 * 60_000,
    state: "current",
    stale: false,
    ...extra,
  })
  const account = (alias: string, provider: string, extra: Partial<PacerAccount> = {}): PacerAccount => ({
    id: `id-${alias}`,
    alias,
    provider,
    windows: [window({})],
    ...extra,
  })
  // As the owner's CLIProxyPacer listed them on 2026-11-08: logins of claude, codex and commandcode, and the providers
  // whose logins serve each model (API keys left out by the service).
  const all = [
    account("claude b", "claude"),
    account("commandcode a", "commandcode"),
    account("claude a", "claude"),
    account("codex a", "codex"),
  ]
  const models = {
    items: [
      { id: "claude-opus-5-5", providers: ["claude"] },
      { id: "gpt-6-luna", providers: ["codex", "commandcode"] },
    ],
  }
  const aliases = (input: Partial<Parameters<typeof usageAccounts>[0]>) =>
    usageAccounts({ accounts: all, model: "claude-opus-5-5", chat: undefined, models, ...input }).map(
      (item) => item.alias,
    )
  const line = (extra: Partial<PacerWindow>, now = NOW, width = 37) =>
    usageLine(usageMeter(window(extra), 2, width, now))

  describe("which accounts (section 1)", () => {
    test("served: every account of the serving account's provider, by alias", () => {
      const served = chat({ model: "gpt-6-luna", provider: "codex", account: "codex a", accountID: "id-codex a" })
      expect(aliases({ model: "gpt-6-luna", chat: served })).toEqual(["codex a"])
      const claude = chat({ model: "claude-opus-5-5", account: "claude b", accountID: "id-claude b" })
      expect(aliases({ chat: claude })).toEqual(["claude a", "claude b"])
    })

    test("a new chat, or one switched to another model: the providers whose logins serve the model", () => {
      expect(aliases({ model: "gpt-6-luna" })).toEqual(["codex a", "commandcode a"])
      // The view is of the model the chat had before.
      const before = chat({ model: "claude-opus-5-5", account: "claude b", accountID: "id-claude b" })
      expect(aliases({ model: "gpt-6-luna", chat: before })).toEqual(["codex a", "commandcode a"])
      // A model CPP doesn't list, or no models read yet: none.
      expect(aliases({ model: "unknown-model" })).toEqual([])
      expect(aliases({ models: undefined })).toEqual([])
    })

    test("a pinned model, as <provider>/<model>, is its view's model on that provider", () => {
      const served = chat({ model: "gpt-6-luna", account: "codex a", accountID: "id-codex a" })
      expect(aliases({ model: "codex/gpt-6-luna", chat: served })).toEqual(["codex a"])
      expect(aliases({ model: "CODEX/GPT-6-Luna", chat: served })).toEqual(["codex a"])
    })

    test("served from an account without meters (an API key): the providers whose logins serve the model", () => {
      const keyed = chat({ model: "claude-opus-5-5", provider: "commandcode", account: "cc-key", accountID: "key-1" })
      expect(aliases({ chat: keyed })).toEqual(["claude a", "claude b"])
    })

    test("two logins of one address: the serving one by its ID", () => {
      const twins = [account("max", "claude", { id: "old" }), account("max", "claude", { id: "new" })]
      expect(chatAccount(twins, chat({ account: "max", accountID: "new" }))?.id).toBe("new")
      // From a service that sends no ID, by alias.
      expect(chatAccount([{ ...twins[0]!, id: undefined }], chat({ account: "max" }))?.alias).toBe("max")
      expect(chatAccount(twins, undefined)).toBeUndefined()
    })
  })

  describe("the tags (section 2)", () => {
    const tags = (input: Partial<Parameters<typeof usageTags>[0]>) =>
      usageTags({ account: all[0]!, serving: undefined, chat: undefined, running: false, ...input }).map(
        (tag) => `${tag.text}:${tag.tone}`,
      )

    test("IN USE while the chat's step runs on it, else LAST USED", () => {
      expect(tags({ serving: all[0], running: true })).toEqual(["IN USE:success"])
      expect(tags({ serving: all[0] })).toEqual(["LAST USED:info"])
      expect(tags({ serving: all[2], running: true })).toEqual([])
    })

    test("NEXT USE where the chat goes once its cache is cold, FORCE USE where a forced move sends it", () => {
      const next = chat({ nextUse: { account: "claude b", reason: "cold_move" } })
      expect(tags({ chat: next })).toEqual(["NEXT USE:info"])
      const forced = chat({
        forceUse: { account: "claude b", when: "now" },
        nextUse: { account: "claude b", reason: "x" },
      })
      expect(tags({ chat: forced })).toEqual(["FORCE USE:warning"])
      // On the chat's own account too: it stays there once cold.
      expect(tags({ chat: next, serving: all[0] })).toEqual(["LAST USED:info", "NEXT USE:info"])
      expect(tags({ chat: chat({ nextUse: { account: "claude a", reason: "cold_move" } }) })).toEqual([])
    })
  })

  describe("a meter (section 3)", () => {
    test("the label, a bar as wide as the rest allows, the percent left and the time to the reset", () => {
      expect(line({})).toBe("5h ████████████░░░░░░░░  62%  1h 20m")
      expect(line({}).length).toBe(36)
      expect(line({ left: 100, resetsAt: NOW + 4 * 3_600_000 + 49 * 60_000 })).toBe(
        "5h ████████████████████ 100%  4h 49m",
      )
      expect(line({ left: 0, resetsAt: NOW + (6 * 24 + 23) * 3_600_000 })).toBe("5h ░░░░░░░░░░░░░░░░░░░░   0%  6d 23h")
      // The bar keeps at least 4 cells.
      expect(usageLine(usageMeter(window({}), 18, 20, NOW))).toBe("5h                 ██░░  62%  1h 20m")
    })

    test("the label column is the card's longest label, from 2 to 18 cells", () => {
      expect(usageLabelWidth([window({ label: "5h" })])).toBe(2)
      expect(usageLabelWidth([window({ label: "5h" }), window({ label: "7d claude_gpt" })])).toBe(13)
      expect(usageLabelWidth([window({ label: "7d a-very-long-scope-name" })])).toBe(18)
      expect(usageLabelWidth([])).toBe(2)
      expect(usageLine(usageMeter(window({ label: "7d claude_gpt" }), 13, 37, NOW))).toBe(
        "7d claude_gpt ██████░░░  62%  1h 20m",
      )
    })

    test("the percent left rounded down, a sliver as <1%", () => {
      expect(usageMeter(window({ left: 99.9 }), 2, 37, NOW).percent).toBe(" 99%")
      expect(usageMeter(window({ left: 0.4 }), 2, 37, NOW).percent).toBe(" <1%")
      expect(usageMeter(window({ left: 0 }), 2, 37, NOW).percent).toBe("  0%")
    })

    test("the time to the reset: two units, minutes rounded up, ~ for CPP's estimate", () => {
      expect(usageCountdown(59 * 60_000)).toBe("59m")
      expect(usageCountdown(59 * 60_000 + 1)).toBe("1h 0m")
      expect(usageCountdown(5 * 3_600_000)).toBe("5h 0m")
      expect(usageCountdown(59_999)).toBe("<1m")
      expect(usageCountdown(24 * 3_600_000)).toBe("1d 0h")
      expect(line({ state: "estimated", resetsAt: NOW + (2 * 24 + 21) * 3_600_000 })).toBe(
        "5h ████████████░░░░░░░░  62% ~2d 21h",
      )
      // No reset known: an empty tail.
      expect(line({ resetsAt: undefined })).toBe("5h ████████████░░░░░░░░  62%        ")
    })

    test("reset, dormant, STALE and unknown, muted", () => {
      const meter = (extra: Partial<PacerWindow>, now = NOW) => usageMeter(window(extra), 2, 37, now)
      expect(meter({ state: "awaiting-confirmation" }).tail.trim()).toBe("reset")
      // The reset passed while nothing new was read.
      expect(meter({}, NOW + 80 * 60_000).tail.trim()).toBe("reset")
      expect(meter({ state: "dormant", left: 100, resetsAt: undefined }).tail.trim()).toBe("dormant")
      expect(meter({ stale: true }).tail.trim()).toBe("STALE")
      // A reading turns stale at staleAt, without anything new being sent.
      expect(meter({ staleAt: NOW + 1000 }).tail.trim()).toBe("1h 20m")
      expect(meter({ staleAt: NOW + 1000 }, NOW + 1000).tail.trim()).toBe("STALE")
      expect(line({ state: "unknown", left: undefined, resetsAt: undefined, stale: true })).toBe(
        "5h ····················      unknown",
      )
      for (const extra of [
        { state: "awaiting-confirmation" as const },
        { state: "dormant" as const },
        { stale: true },
        { left: undefined },
      ])
        expect(meter(extra).tone).toBe("muted")
    })

    test("the bar's color: above 20% left, at 20% or less, at 10% or less", () => {
      const tone = (left: number) => usageMeter(window({ left }), 2, 37, NOW).tone
      expect([tone(21), tone(20), tone(11), tone(10), tone(0)]).toEqual([
        "normal",
        "low",
        "low",
        "critical",
        "critical",
      ])
    })
  })
})

describe("a row of the Requests tab (section 7)", () => {
  const at = new Date(2026, 10, 6, 14, 2, 13).getTime()
  /** The row in the columns sized to it alone. */
  const row = (extra: Partial<PacerRequest>, width = 110) => {
    const one = request(0, { at, ...extra })
    return requestRow(one, requestLayout(width, [one]))
  }
  const cells = (text: string) => text.split(/\s{2,}/).filter(Boolean)
  /** The header and the rows, in the columns sized to them. */
  const table = (requests: PacerRequest[], width: number) => {
    const layout = requestLayout(width, requests)
    return [requestHeader(layout), ...requests.map((item) => requestRow(item, layout))]
  }

  test("time, kind, model, account, cache read and write, verdict and cost, in one line of the width", () => {
    const text = row({})
    expect(text).toHaveLength(110)
    expect(cells(text)).toEqual(["14:02:13", "step", "claude-opus-4-5", "max-2", "120.3K/1.2K", "hit", "$0.0123"])
    expect(requestTone(request(0))).toBe("base")
  })

  test("each kind: a step, the subagent's agent, a compaction, a title, a ping", () => {
    expect(row({ subagent: true, sessionID: "ses_subagent", agent: "explore" })).toContain(" explore ")
    expect(row({ kind: "compaction", verdict: undefined })).toContain(" compaction ")
    expect(row({ kind: "title", verdict: undefined })).toContain(" title ")
    expect(row({ kind: "ping" })).toContain(" ping ")
  })

  test("a miss shows as a warning, with its cause and the part that changed", () => {
    const text = requestRow(miss(0, { at }), requestLayout(110, [miss(0, { at })]))
    expect(cells(text)).toEqual([
      "14:02:13",
      "step",
      "claude-opus-4-5",
      "max-2",
      "0/98.1K",
      "miss · prefix changed · system",
      "$0.0123",
    ])
    expect(requestTone(miss(0))).toBe("warning")
    expect(requestTone(miss(0, { verdict: "partial" }))).toBe("warning")
  })

  test("a failed request, and one CPP refused before choosing an account", () => {
    expect(row({ failed: true, status: 529, verdict: undefined })).toContain("failed 529")
    const refused = row({
      failed: true,
      status: 429,
      account: undefined,
      refusal: "model_cooldown",
      verdict: undefined,
    })
    expect(cells(refused)).toEqual([
      "14:02:13",
      "step",
      "claude-opus-4-5",
      "–",
      "120.3K/1.2K",
      "refused: model_cooldown",
      "$0.0123",
    ])
    expect(requestTone(request(0, { failed: true }))).toBe("error")
  })

  // Found live: at 160 columns the model and the account were cut while some 30 cells of the line stayed blank, and at
  // 80 the cache read and write were dropped while some 35 were.
  const live = [
    request(0, { at, model: "claude-sonnet-4-5", account: "claude-apikey", verdict: "hit" }),
    request(1, { at, model: "claude-sonnet-4-5", account: "claude-apikey", kind: "title", verdict: "cold" }),
    miss(2, { at, model: "claude-sonnet-4-5", account: "claude-apikey", cause: "provider", changedPart: undefined }),
    request(3, { at, model: "claude-sonnet-4-5", account: "claude-apikey", kind: "ping" }),
  ]

  test("with blank room nothing is cut, every column shown: the tab at 160 and 120 columns", () => {
    for (const width of [150, 110]) {
      const lines = table(live, width)
      for (const line of lines) expect(line).toHaveLength(width)
      expect(lines.join("\n")).not.toContain("…")
      expect(cells(lines[0]!)).toEqual(["time", "kind", "model", "account", "read/write", "verdict", "cost"])
      expect(cells(lines[3]!)).toEqual([
        "14:02:13",
        "step",
        "claude-sonnet-4-5",
        "claude-apikey",
        "0/98.1K",
        "miss · provider",
        "$0.0123",
      ])
    }
  })

  test("a narrow window drops the model, then the account, then the cache, only when they don't fit, and cuts last", () => {
    // The tab at 80 columns: no model, the rest whole.
    const at80 = table(live, 70)
    expect(at80.join("\n")).not.toContain("…")
    expect(cells(at80[0]!)).toEqual(["time", "kind", "account", "read/write", "verdict", "cost"])
    expect(cells(at80[3]!)).toEqual(["14:02:13", "step", "claude-apikey", "0/98.1K", "miss · provider", "$0.0123"])
    // At 60: no account either.
    const at60 = table(live, 50)
    expect(cells(at60[0]!)).toEqual(["time", "kind", "verdict", "cost"])
    expect(cells(at60[3]!)).toEqual(["14:02:13", "step", "miss · provider", "$0.0123"])
    // In that order: at 53 the account would fit where the read and write no longer do, and still goes first.
    expect(cells(table(live, 53)[0]!)).toEqual(["time", "kind", "verdict", "cost"])
    for (const line of at80) expect(line).toHaveLength(70)
    for (const line of at60) expect(line).toHaveLength(50)

    // A long verdict keeps room for its cause before a column is added, and what doesn't fit is cut, not dropped.
    const rows = [request(0, { at }), miss(1, { at })]
    expect(requestLayout(110, rows)).toEqual({
      width: 110,
      kind: 10,
      model: 18,
      account: 12,
      cache: 12,
      verdict: 31,
      cost: 7,
    })
    expect(cells(table(rows, 90)[2]!)).toEqual([
      "14:02:13",
      "step",
      "claude-opus…",
      "max-2",
      "0/98.1K",
      "miss · prefix changed · syst…",
      "$0.0123",
    ])
    expect(cells(table(rows, 80)[2]!)).toEqual([
      "14:02:13",
      "step",
      "max-2",
      "0/98.1K",
      "miss · prefix changed · system",
      "$0.0123",
    ])
    expect(cells(table(rows, 70)[2]!)).toEqual([
      "14:02:13",
      "step",
      "0/98.1K",
      "miss · prefix changed · system",
      "$0.0123",
    ])
    expect(cells(table(rows, 60)[2]!)).toEqual(["14:02:13", "step", "miss · prefix changed · system", "$0.0123"])
    const narrow = table(rows, 50)[2]!
    expect(narrow).toHaveLength(50)
    expect(cells(narrow)).toEqual(["14:02:13", "step", "miss · prefix changed · …", "$0.0123"])
  })

  test("room to spare widens the columns to their usual widths first, so a longer value arriving later fits", () => {
    const rows = [
      request(0, { at, model: "m", account: "a", tokens: { ...request(0).tokens, cacheRead: 0, cacheWrite: 0 } }),
    ]
    expect(requestLayout(150, rows)).toEqual({
      width: 150,
      kind: 10,
      model: 18,
      account: 12,
      cache: 12,
      verdict: 71,
      cost: 7,
    })
    const layout = requestLayout(150, rows)
    const later = request(1, { at, kind: "compaction", model: "claude-opus-4-5", account: "max-2", verdict: "miss" })
    expect(cells(requestRow(later, layout))).toEqual([
      "14:02:13",
      "compaction",
      "claude-opus-4-5",
      "max-2",
      "120.3K/1.2K",
      "miss",
      "$0.0123",
    ])
  })
})

describe("what changed (section 7)", () => {
  test("the verdict, the cause, the tokens written again, the miss cost and the request it was compared with", () => {
    const change = promptChange(miss(3), {
      comparedWith: { id: "req_prev", at: new Date(2026, 10, 6, 14, 1, 2).getTime() },
    })
    const lines = promptChangeLines(change)
    expect(lines.head.map((line) => line.text)).toEqual([
      "miss · prefix changed · system changed",
      "98.1K tokens written again · the miss cost $0.41",
      "compared with req_prev of 14:01:02",
    ])
    expect(lines.head[0]!.tone).toBe("warning")
    expect(lines.items.map((line) => line.text)).toEqual([
      "changed  system     messages[0].content[0]  12.3K chars  You are openforge",
      "new      prompt     messages[5]  120 chars  fix the test",
      "marker   tool       tools[3]  800 chars  bash",
      "45 unchanged",
    ])
  })

  test("no request to compare with", () => {
    const lines = promptChangeLines(promptChange(miss(3), { comparedWith: undefined }))
    expect(lines.head.map((line) => line.text)).toContain("compared with no earlier request")
  })

  test("prompt no longer kept, and kept only in part", () => {
    const none = promptChangeLines(promptChange(miss(3), { kept: "none", items: [] }))
    expect(none.head.at(-1)!.text).toBe("prompt no longer kept")
    expect(none.items).toEqual([])
    const part = promptChangeLines(
      promptChange(miss(3), {
        kept: "part",
        removed: ["messages[7]"],
        items: [{ path: "messages[2]", kind: "dropped", summary: "", chars: 4000, change: "changed", error: false }],
      }),
    )
    expect(part.items.map((line) => line.text)).toEqual([
      "changed  dropped    messages[2]  4.0K chars",
      "removed: messages[7]",
      "45 unchanged",
      "CLIProxyPacer kept only fingerprints of some items",
    ])
  })

  test("a tool result marked as an error", () => {
    const lines = promptChangeLines(
      promptChange(miss(3), {
        items: [{ path: "messages[9]", kind: "result", summary: "exit 1", chars: 50, change: "new", error: true }],
      }),
    )
    expect(lines.items[0]).toEqual({ text: "new      result     messages[9]  50 chars  error  exit 1", tone: "error" })
  })

  test("a web tool call sent no prompt (spec cliproxypacer-step-2, section 4); nor did any request that goes by its row", () => {
    const call = webCall(0, 300)
    expect(promptless(call.id)).toBe(true)
    expect(promptlessLines(call)).toEqual({
      head: [{ text: "A web tool call sends no prompt, so there is nothing to compare", tone: "muted" }],
      items: [],
    })
    // CPP records a web tool call so; were it to record another request so, the line doesn't call it one.
    expect(promptlessLines({ kind: "other" }).head.map((line) => line.text)).toEqual([
      "CLIProxyPacer recorded this request without a request ID, so it keeps no prompt to compare",
    ])
    expect(promptless(request(0).id)).toBe(false)
  })
})

describe("Enter: where a request ended (section 7)", () => {
  const messages = [
    step("msg_1", { created: NOW - 50_000, completed: NOW - 45_000, proxyRequestID: "req_a" }),
    step("msg_2", { created: NOW - 40_000, completed: NOW - 30_000, proxyRequestID: "req_b" }),
    step("msg_3", { created: NOW - 10_000, completed: NOW - 5_000, proxyRequestID: "req_c" }),
  ]

  test("a step's request: the message that keeps its ID, exactly", () => {
    expect(requestTarget(request(0, { id: "req_b", at: NOW - 40_000 }), messages)).toEqual({
      messageID: "msg_2",
      exact: true,
    })
  })

  test("a subagent's request: the message of the subagent's chat that keeps its ID", () => {
    const subagent = [step("msg_s", { created: NOW - 20_000, proxyRequestID: "req_s" })]
    expect(
      requestTarget(request(0, { id: "req_s", subagent: true, sessionID: "ses_subagent", agent: "explore" }), subagent),
    ).toEqual({ messageID: "msg_s", exact: true })
  })

  test("a ping or a title: the reply before it", () => {
    expect(requestTarget(request(0, { id: "req_p", kind: "ping", at: NOW - 20_000 }), messages)).toEqual({
      messageID: "msg_2",
      exact: false,
    })
    expect(requestTarget(request(0, { id: "req_t", kind: "title", at: NOW - 1_000 }), messages).messageID).toBe("msg_3")
    // A title sent with the chat's first step has no reply before it: that step.
    expect(requestTarget(request(0, { id: "req_t", kind: "title", at: NOW - 60_000 }), messages).messageID).toBe(
      "msg_1",
    )
  })

  test("a request no message names: the chat's first step that started after it", () => {
    expect(requestTarget(request(0, { id: "req_failed", at: NOW - 41_000, failed: true }), messages)).toEqual({
      messageID: "msg_2",
      exact: false,
    })
    // None after it: the end of the chat.
    expect(requestTarget(request(0, { id: "req_late", at: NOW }), messages)).toEqual({
      messageID: undefined,
      exact: false,
    })
  })
})

describe("holding rows", () => {
  test("a first page read again over the rows held keeps the older rows held beyond it and their cursor", () => {
    const held = { items: [request(2), request(3), request(4), request(5)], cursor: "req_5" }
    // Two new requests: the fresh first page of 4 has them and two of the held ones.
    const fresh = { items: [request(0), request(1), request(2), request(3)], cursor: "req_3", asOf: NOW }
    const merged = mergeFirst(held, fresh)
    expect(merged.items.map((item) => item.id)).toEqual(["req_0", "req_1", "req_2", "req_3", "req_4", "req_5"])
    expect(merged.cursor).toBe("req_5")
    // A first page that is the whole list replaces it.
    expect(mergeFirst(held, { items: [request(0)], asOf: NOW }).items).toHaveLength(1)
  })

  test("a first page read again keeps every web tool call held beyond it (spec cliproxypacer-step-2, section 4)", () => {
    // CPP gives the calls no request ID: each goes by its row, so none takes another's place.
    const held = { items: [webCall(2, 302), request(3), webCall(4, 304), webCall(5, 305)], cursor: "row:305" }
    const fresh = { items: [webCall(0, 300), webCall(1, 301), webCall(2, 302), request(3)], cursor: "req_3", asOf: NOW }
    expect(mergeFirst(held, fresh).items.map((item) => item.id)).toEqual([
      "row:300",
      "row:301",
      "row:302",
      "req_3",
      "row:304",
      "row:305",
    ])
  })

  test("the first row on screen stays where it was unless the selection would leave the screen", () => {
    // At the top, a new row above the selection shows; the selection keeps its request.
    expect(listTop(0, 1, 6, 10)).toBe(0)
    // Selected on the last line: the new row stays above the screen, nothing on screen moves.
    expect(listTop(0, 6, 6, 10)).toBe(1)
    expect(listTop(4, 2, 6, 10)).toBe(2)
    expect(listTop(9, 9, 6, 10)).toBe(4)
  })
})

describe("a cache notice's card (spec cliproxypacer-cache-notices, section 3)", () => {
  test("a miss and a partial reuse, with the tokens not reused", () => {
    expect(noticeTitle(notice(0))).toBe("Cache miss · 152K tokens not reused")
    expect(noticeTitle(notice(0, { verdict: "partial", tokens: 18_000 }))).toBe(
      "Partial cache reuse · 18K tokens not reused",
    )
  })

  test("a row without its count shows none", () => {
    expect(noticeTitle(notice(0, { tokens: undefined }))).toBe("Cache miss")
    expect(noticeTitle(notice(0, { verdict: "partial", tokens: undefined }))).toBe("Partial cache reuse")
  })

  test("tokens as the card counts them", () => {
    expect([0, 999, 1_000, 1_500, 18_449, 98_100, 152_340, 999_499, 999_500, 1_240_000].map(formatTokens)).toEqual([
      "0",
      "999",
      "1K",
      "1.5K",
      "18.4K",
      "98.1K",
      "152K",
      "999K",
      "1M",
      "1.2M",
    ])
  })

  test("its age: just now, then whole minutes", () => {
    expect(noticeAge(NOW, NOW)).toBe("just now")
    expect(noticeAge(NOW - 59_999, NOW)).toBe("just now")
    expect(noticeAge(NOW - 60_000, NOW)).toBe("1 min ago")
    expect(noticeAge(NOW - 3 * 60_000 - 30_000, NOW)).toBe("3 min ago")
    // A request stamped a little ahead of this machine's clock is just now, not a negative age.
    expect(noticeAge(NOW + 5_000, NOW)).toBe("just now")
  })

  test("the chat's title, agent and model; its ID without a title", () => {
    expect(noticeSubject(notice(0))).toBe("Fix the flaky test · build · claude-opus-4-5")
    expect(noticeSubject(notice(0, { title: undefined, agent: undefined }))).toBe("ses_chat · claude-opus-4-5")
  })

  test("at most 4 cards, fewer in a short terminal, then the count of the others", () => {
    expect([40, 24, 20, 19, 16, 15, 12, 8, 3].map(noticesShown)).toEqual([4, 4, 3, 2, 2, 1, 1, 1, 1])
    expect(noticesMore(6, 4)).toBe("+2 more cache notices")
    expect(noticesMore(4, 4)).toBeUndefined()
    expect(noticesMore(1, 4)).toBeUndefined()
  })
})
