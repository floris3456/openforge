import { describe, expect, test } from "bun:test"
import type { PacerAccount, PacerRequest, PacerWindow } from "@opencode/client"
import { promptless } from "@opencode/schema/pacer"
import { mergeFirst } from "../../src/context/pacer"
import {
  cacheLabel,
  cacheText,
  chatAccount,
  endsCompacted,
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
  usageGroupName,
  usagePlanName,
  usageSection,
  usageStrips,
  usageText,
  windowApplies,
  windowLength,
  type UsageSpan,
} from "../../src/pacer/format"
import { requestTarget } from "../../src/pacer/jump"
import { stringWidth } from "../../src/util/string-width"
import { listTop } from "../../src/routes/session/composer/requests-tab"
import { chat, miss, notice, NOW, promptChange, request, step, webCall } from "./fixture"

// Written from spec cliproxypacer-step-1: section 4's table and section 7's rows, Enter and what changed; and from
// spec cliproxypacer-usage-meters, which replaced step 1's section 5.

describe("the toolbar's cache item (section 4)", () => {
  const text = (view: Parameters<typeof cacheLabel>[0], now = NOW, compacted = false) => {
    const label = cacheLabel(view, now, compacted)
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

  // The owner, 2026-11-10: "When compaction had happened it says cache cold in the bottom, it should say compacted."
  test("compacted and nothing cached since: compacted, muted, whatever the old cache does", () => {
    const ended = { active: false, left: 0, sent: 0, failed: false, stopped: "compacted" }
    // The chat's newest answer is a summary: cold, still warm, or counted down.
    expect(text(chat({ warm: false }), NOW, true)).toEqual({ text: "compacted", tone: "muted" })
    expect(text(chat(), NOW, true)).toEqual({ text: "compacted", tone: "muted" })
    expect(text(chat(), chat().coldAt! + 1, true)).toEqual({ text: "compacted", tone: "muted" })
    // CPP ended the pings for a compaction through it and started none since: also while the next step runs, before
    // its reply arms new ones.
    expect(text(chat({ warm: false, pings: ended }))).toEqual({ text: "compacted", tone: "muted" })
    expect(text(chat({ warmUntil: NOW + 60_000, coldAt: NOW + 60_000, pings: ended }))).toEqual({
      text: "compacted",
      tone: "muted",
    })
    // A reply since armed new pings: the countdown again.
    expect(text(chat({ pings: { ...ended, active: true, left: 4, intervalMs: 270_000 } })).text).toBe("warm 23:41")
    // Pings ended for any other reason: as before.
    expect(text(chat({ warm: false, pings: { ...ended, stopped: "event" } })).text).toBe("cache cold")
    // The account that can't serve the next step still says so first.
    expect(text(chat({ forceUse: { account: "max-1", when: "now" } }), NOW, true).text).toBe(
      "account used up · next step moves to max-1",
    )
  })

  test("a chat ends compacted when its newest answer, before a staged revert, is a finished summary", () => {
    const summary = (id: string, status: "completed" | "running" | "failed") =>
      ({ id, type: "compaction", status, reason: "manual", summary: "the summary", time: { created: NOW } }) as never
    const user = { id: "msg_user", type: "user", text: "next", time: { created: NOW } } as never
    expect(endsCompacted([step("msg_1", { created: NOW - 60_000 }), summary("msg_2", "completed")])).toBe(true)
    // Kept messages and a prompt after the summary are no answer.
    expect(endsCompacted([summary("msg_2", "completed"), user])).toBe(true)
    // A step since, a summary still being written or one that failed: not compacted.
    expect(endsCompacted([summary("msg_2", "completed"), user, step("msg_3", { created: NOW })])).toBe(false)
    expect(endsCompacted([step("msg_1", { created: NOW - 60_000 }), summary("msg_2", "running")])).toBe(false)
    expect(endsCompacted([step("msg_1", { created: NOW - 60_000 }), summary("msg_2", "failed")])).toBe(false)
    expect(endsCompacted([])).toBe(false)
    // A revert staged to before the summary leaves the step before it the newest answer.
    expect(endsCompacted([step("msg_1", { created: NOW - 60_000 }), summary("msg_2", "completed")], "msg_2")).toBe(
      false,
    )
    expect(endsCompacted([summary("msg_2", "completed"), user, step("msg_3", { created: NOW })], "msg_3")).toBe(true)
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
  const SEVEN = { label: "7d", seconds: 604_800 }
  const account = (alias: string, provider: string, extra: Partial<PacerAccount> = {}): PacerAccount => ({
    id: `id-${alias}`,
    alias,
    provider,
    windows: [window({})],
    ...extra,
  })

  describe("which accounts (section 1)", () => {
    // As the owner's CLIProxyPacer listed them on 2026-11-08: logins of claude, codex and commandcode, commandcode's
    // API key, and the providers serving each model, API keys included.
    const all = [
      account("claude b", "claude"),
      account("commandcode a", "commandcode"),
      account("commandcode-apikey", "commandcode"),
      account("claude a", "claude"),
      account("codex a", "codex"),
    ]
    const models = {
      items: [
        // Claude's commandcode route is the API key only: 1 of commandcode's accounts.
        { id: "claude-haiku-5-5", providers: ["claude", "commandcode"], partial: ["commandcode"] },
        { id: "commandcode/claude-haiku-5-5", providers: ["commandcode"], partial: ["commandcode"] },
        { id: "claude-opus-5-5", providers: ["claude"] },
        { id: "gpt-6-luna", providers: ["codex", "commandcode"] },
      ],
    }
    const aliases = (input: Partial<Parameters<typeof usageAccounts>[0]>) =>
      usageAccounts({ accounts: all, model: "claude-opus-5-5", chat: undefined, models, ...input }).accounts.map(
        (item) => item.alias,
      )

    test("served: every account of the serving account's provider that serves the model, by alias", () => {
      const served = chat({ model: "gpt-6-luna", provider: "codex", account: "codex a", accountID: "id-codex a" })
      expect(aliases({ model: "gpt-6-luna", chat: served })).toEqual(["codex a"])
      const claude = chat({ model: "claude-opus-5-5", account: "claude b", accountID: "id-claude b" })
      expect(aliases({ chat: claude })).toEqual(["claude a", "claude b"])
    })

    test("a new chat, or one switched to another model: the providers serving the model, API keys too", () => {
      expect(aliases({ model: "gpt-6-luna" })).toEqual(["codex a", "commandcode a", "commandcode-apikey"])
      // The view is of the model the chat had before.
      const before = chat({ model: "claude-opus-5-5", account: "claude b", accountID: "id-claude b" })
      expect(aliases({ model: "gpt-6-luna", chat: before })).toEqual(["codex a", "commandcode a", "commandcode-apikey"])
      // A model CPP doesn't list, or no models read yet: none.
      expect(aliases({ model: "unknown-model" })).toEqual([])
      expect(aliases({ models: undefined })).toEqual([])
    })

    test("a pinned model, as <provider>/<model>, is its view's model on that provider", () => {
      const served = chat({ model: "gpt-6-luna", account: "codex a", accountID: "id-codex a" })
      expect(aliases({ model: "codex/gpt-6-luna", chat: served })).toEqual(["codex a"])
      expect(aliases({ model: "CODEX/GPT-6-Luna", chat: served })).toEqual(["codex a"])
    })

    // The owner, 2026-11-08: "If that same model is used, but from a different provider (command code haiku for
    // example), you see only those", of the accounts "that has that model available".
    test("a provider only some of whose accounts serve the model: only those CPP names for the chat", () => {
      const keyed = chat({
        model: "claude-haiku-5-5",
        provider: "commandcode",
        account: "commandcode-apikey",
        accountID: "id-commandcode-apikey",
      })
      expect(aliases({ model: "claude-haiku-5-5", chat: keyed })).toEqual(["commandcode-apikey"])
      expect(aliases({ model: "commandcode/claude-haiku-5-5", chat: keyed })).toEqual(["commandcode-apikey"])
      // Before CPP has served it: that provider's none, the other provider's all.
      expect(aliases({ model: "claude-haiku-5-5" })).toEqual(["claude a", "claude b"])
      expect(aliases({ model: "commandcode/claude-haiku-5-5" })).toEqual([])
      // Where the chat moves, though CPP names it by alias.
      const moving = chat({
        model: "claude-haiku-5-5",
        account: "claude a",
        accountID: "id-claude a",
        nextUse: { account: "commandcode-apikey", reason: "cold_move" },
      })
      expect(aliases({ model: "claude-haiku-5-5", chat: moving })).toEqual([
        "claude a",
        "claude b",
        "commandcode-apikey",
      ])
    })

    // Found live on 2026-11-08 (run/evidence/cpp-usage-meters/live-1, issue 1): CPP takes the new model into the
    // chat's view at once and keeps its account until a step of it is routed.
    test("switched to a model the serving account's provider doesn't serve: the model's providers", () => {
      const switched = chat({
        model: "claude-opus-5-5",
        provider: "codex",
        account: "codex a",
        accountID: "id-codex a",
      })
      expect(aliases({ chat: switched })).toEqual(["claude a", "claude b"])
      // One CPP says nothing of: the view stands.
      expect(aliases({ chat: switched, models: { items: [] } })).toEqual(["codex a"])
    })

    // Issue 4 of the same run: the chat's next account was another provider's, and nothing showed it.
    test("where the chat moves, also on another provider", () => {
      const served = {
        model: "gpt-6-luna",
        provider: "codex",
        account: "codex a",
        accountID: "id-codex a",
      }
      const next = chat({ ...served, nextUse: { account: "commandcode a", reason: "cold_move" } })
      expect(aliases({ model: "gpt-6-luna", chat: next })).toEqual(["codex a", "commandcode a", "commandcode-apikey"])
      const forced = chat({ ...served, forceUse: { account: "claude a", when: "now" } })
      expect(aliases({ model: "gpt-6-luna", chat: forced })).toEqual(["claude a", "claude b", "codex a"])
      // A view of another model: its moves are that model's, so they neither add accounts nor mark them.
      const other = usageAccounts({ accounts: all, model: "claude-opus-5-5", chat: next, models })
      expect(other.accounts.map((item) => item.alias)).toEqual(["claude a", "claude b"])
      expect(other.chat).toBeUndefined()
      expect(usageAccounts({ accounts: all, model: "gpt-6-luna", chat: next, models }).chat).toBe(next)
    })

    test("two logins of one address: the serving one by its ID", () => {
      const twins = [account("max", "claude", { id: "old" }), account("max", "claude", { id: "new" })]
      expect(chatAccount(twins, chat({ account: "max", accountID: "new" }))?.id).toBe("new")
      // From a service that sends no ID, by alias.
      expect(chatAccount([{ ...twins[0]!, id: undefined }], chat({ account: "max" }))?.alias).toBe("max")
      expect(chatAccount(twins, undefined)).toBeUndefined()
    })
  })

  // CLIProxyPacer's own cases (`applies_and_antigravity_groups`, crates/cpa-pacer/src/meters/tests.rs at 272baab4).
  test("the windows that limit a model, as CPP decides", () => {
    const cases: [string, string, boolean][] = [
      ["all", "anything", true],
      ["oauth", "anything", true],
      ["opus", "claude-Opus-4-6", true],
      ["opus", "claude-sonnet-4-6", false],
      ["spark", "gpt-5.3-codex-spark", true],
      ["gemini", "gemini-3-pro", true],
      ["gemini", "gemini-opus-4-6-thinking", false],
      ["claude_gpt", "gemini-opus-4-6-thinking", true],
      ["claude_gpt", "gpt-oss-120b", true],
      ["model:GPT-5", "gpt-5", true],
      ["model:gpt-5", "gpt-5.1", false],
      ["limit:foo", "foo", false],
      ["code-review", "gpt-5", false],
      ["fable", "claude-opus-4-6", false],
      ["fable", "claude-Fable-5-1", true],
      ["unknown", "x", false],
      // Pinned to a provider.
      ["haiku", "commandcode/claude-haiku-5-5", true],
      ["model:claude-haiku-5-5", "commandcode/claude-haiku-5-5", true],
    ]
    for (const [scope, model, applies] of cases)
      expect([scope, model, windowApplies({ scope }, model)]).toEqual([scope, model, applies])
  })

  describe("the section (sections 2 to 4)", () => {
    const M = 60_000
    const H = 60 * M
    const D = 24 * H
    /** The section at 37 cells by default; every line of it exactly the section's width. */
    const section = (input: Partial<Parameters<typeof usageSection>[0]> & { accounts: readonly PacerAccount[] }) => {
      const out = usageSection({
        model: "claude-opus-5-5",
        serving: undefined,
        chat: undefined,
        running: false,
        width: 37,
        now: NOW,
        ...input,
      })
      expect(out.map((line) => stringWidth(usageText(line)))).toEqual(out.map(() => input.width ?? 37))
      return out
    }
    const texts = (lines: UsageSpan[][]) => lines.map(usageText)
    /** As the design's preview draws a section: `▒` a fill, `·` a track (an alternate row's track blank). */
    const preview = (lines: UsageSpan[][]) =>
      lines.map((line) =>
        line
          .flatMap((span) =>
            Array.from(span.text, (character) => {
              if (character !== " " || span.background === undefined) return character
              if (span.background !== "track") return "▒"
              return span.alternate ? " " : "·"
            }),
          )
          .join(""),
      )
    const BACKGROUND = { track: "T", success: "S", warning: "W", error: "E", muted: "M" } as const
    const INK = { base: "b", muted: "m", faint: "f", success: "s", info: "i", warning: "w", error: "e" } as const
    /**
     * Each line's text, each cell's background (`.` the sidebar's, `S` a success fill, `T` a track…, lower case on an
     * alternate row) and each non-blank cell's ink (`b` base, `m` muted, `f` faint…, upper case in bold).
     */
    const grid = (lines: UsageSpan[][]) =>
      lines.map((line) => {
        const cells = line.flatMap((span) => Array.from(span.text, (character) => ({ character, span })))
        return [
          cells.map((cell) => cell.character).join(""),
          cells
            .map(({ span }) => {
              if (span.background === undefined) return "."
              const tone = BACKGROUND[span.background]
              return span.alternate ? tone.toLowerCase() : tone
            })
            .join(""),
          cells
            .map(({ character, span }) => {
              if (character === " ") return " "
              return span.bold ? INK[span.ink].toUpperCase() : INK[span.ink]
            })
            .join(""),
        ] as const
      })
    /** The lines that aren't rows: the title, names and labels. */
    const heads = (lines: UsageSpan[][]) =>
      lines
        .filter((line) => line.every((span) => span.background === undefined && span.text.trim() !== "no reading yet"))
        .map(usageText)

    test("a group's name: the provider's, then the provider's own name of the plan, else CPP's name of its ID", () => {
      const name = (provider: string, plan?: string, planName?: string) => usageGroupName({ provider, plan, planName })
      // The owner's server on 2026-11-09.
      expect(name("claude", "default_claude_max_20x", "Ultra")).toBe("Claude Ultra")
      expect(name("antigravity", "g1-pro-tier", "Google AI Pro")).toBe("Antigravity Google AI Pro")
      expect(name("claude", "claude_pro")).toBe("Claude Pro")
      expect(name("commandcode", "individual-goat")).toBe("Command Code GOAT")
      expect(name("codex", "plus")).toBe("Codex Plus")
      // The provider's own name first, whatever CPP's name of the ID.
      expect(name("claude", "claude_pro", "Team")).toBe("Claude Team")
      // CPP's table (ui/src/core.ts planName, CPP 1bc19d1e), row by row.
      const table: [string, string][] = [
        ["default_claude_max_20x", "Ultra"],
        ["default_claude_max_5x", "Max 5x"],
        ["default_claude_pro", "Pro"],
        ["claude_pro", "Pro"],
        ["claude_max", "Max"],
        ["claude_team", "Team"],
        ["claude_enterprise", "Enterprise"],
        ["g1-pro-tier", "Pro"],
        ["g1-ultra-tier", "Ultra"],
        ["free-tier", "Free"],
        ["standard-tier", "Standard"],
        ["legacy-tier", "Legacy"],
        ["edu", "Edu"],
        ["individual-go", "Go"],
        ["individual-goat", "GOAT"],
        ["individual-pro", "Pro"],
        ["individual-pro-v1", "Pro"],
        ["individual-max", "Max"],
        ["individual-provider", "Provider"],
        ["individual-ultra", "Ultra"],
        ["teams-pro", "Teams Pro"],
      ]
      for (const [plan, plain] of table)
        expect([plan, usagePlanName({ provider: "codex", plan })]).toEqual([plan, plain])
      // Any other ID: without a leading default_ or claude_ and a trailing -tier, _ and - as spaces, each word
      // capitalized.
      expect(usagePlanName({ provider: "codex", plan: "plus" })).toBe("Plus")
      expect(usagePlanName({ provider: "codex", plan: "default_team_plan" })).toBe("Team Plan")
      expect(usagePlanName({ provider: "claude", plan: "claude_max_8x" })).toBe("Max 8x")
      expect(usagePlanName({ provider: "antigravity", plan: "g1-business-tier" })).toBe("G1 Business")
      // No plan: default_claude_ai, and for Claude a free one; the provider alone.
      expect(name("claude", "default_claude_ai")).toBe("Claude")
      expect(name("claude", "free-tier")).toBe("Claude")
      expect(name("claude", "free")).toBe("Claude")
      expect(name("claude", undefined, "Free")).toBe("Claude")
      expect(name("antigravity", "free-tier")).toBe("Antigravity Free")
      expect(name("opencode-go")).toBe("OpenCode Go")
      // A provider of no known name: CPP's.
      expect(name("newprov", "plus")).toBe("newprov Plus")
    })

    test("a window's length, and the time to its reset in one unit or two", () => {
      expect([18_000, 604_800, 2_592_000, 5_400, 45].map(windowLength)).toEqual(["5h", "7d", "30d", "90m", "45s"])
      const both = (ms: number) => [usageCountdown(ms), usageCountdown(ms, true)]
      expect(both(59_999)).toEqual(["<1m", "<1m"])
      // Minutes round up, hours and days down; the second unit goes when it is 0.
      expect(both(46 * M + 1)).toEqual(["47m", "47m"])
      expect(both(59 * M + 1)).toEqual(["1h", "1h"])
      expect(both(2 * H + 9 * M + 30_000)).toEqual(["2h", "2h 10m"])
      expect(both(2 * H)).toEqual(["2h", "2h"])
      expect(both(23 * H + 59 * M)).toEqual(["23h", "23h 59m"])
      expect(both(D)).toEqual(["1d", "1d"])
      expect(both(6 * D + 23 * H)).toEqual(["6d", "6d 23h"])
      expect(both(7 * D)).toEqual(["7d", "7d"])
    })

    test("one group per provider and plan: by provider, then plan in CPP's order, others after, none last", () => {
      const one = (alias: string, provider: string, extra: Partial<PacerAccount> = {}) =>
        account(alias, provider, { windows: [window({})], ...extra })
      const out = section({
        accounts: [
          one("p1", "claude", { plan: "claude_pro" }),
          one("u1", "claude", { plan: "default_claude_max_20x", planName: "Ultra" }),
          one("n1", "claude"),
          one("b1", "claude", { plan: "claude_bespoke" }),
          one("p2", "claude", { plan: "default_claude_pro" }),
          one("x1", "codex", { plan: "plus" }),
          one("a1", "antigravity", { plan: "g1-ultra-tier" }),
          one("a2", "antigravity", { plan: "g1-pro-tier" }),
        ],
      })
      expect(heads(out).map((line) => line.trimEnd())).toEqual([
        "Usage",
        "Antigravity Pro 5h",
        "Antigravity Ultra",
        "                5h",
        "Claude Ultra    5h",
        "Claude Pro      5h",
        "Claude Bespoke  5h",
        "Claude          5h",
        "Codex Plus      5h",
      ])
      // Two plan IDs CPP names alike: one group, its accounts by alias.
      expect(
        texts(out)
          .slice(8, 11)
          .map((line) => line.trimEnd()),
      ).toEqual(["Claude Pro      5h", "   62%      1h 20m", "   62%      1h 20m"])
    })

    test("the labels: on the name's line when it ends a cell before the first, else under it; names never cut", () => {
      const head = (provider: string, plan: string | undefined, windows: PacerWindow[], model = "claude-fable-5") =>
        heads(section({ accounts: [account("a", provider, { plan, windows })], model }))
          .slice(1)
          .map((line) => line.trimEnd())
      const two = [window({}), window(SEVEN)]
      expect(head("claude", "claude_pro", two)).toEqual(["Claude Pro      5h                7d"])
      // The first label starts at 16: a name of 15 cells ends a cell before it, one of 16 doesn't.
      expect(head("provider-123456", undefined, two)).toEqual(["provider-123456 5h                7d"])
      expect(head("provider-1234567", undefined, two)).toEqual([
        "provider-1234567",
        "                5h                7d",
      ])
      // Three windows: the first label starts at 10.
      const fable = [...two, window({ ...SEVEN, scope: "fable" })]
      expect(head("codex", undefined, fable)).toEqual(["Codex     5h          7d    fable 7d"])
      expect(head("claude", "default_claude_max_20x", fable)).toEqual([
        "Claude Ultra",
        "          5h          7d    fable 7d",
      ])
      // A scope every column shares goes unsaid; one too long for its strip is cut, never the length.
      expect(head("codex", undefined, [window({ scope: "fable" }), window({ ...SEVEN, scope: "fable" })])).toEqual([
        "Codex           5h                7d",
      ])
      expect(head("codex", undefined, [window({}), window({ ...SEVEN, scope: "model:claude-fable-5" })])).toEqual([
        "Codex           5h  model:claude… 7d",
      ])
      // Only a name wider than the whole line is cut.
      expect(head("a-provider-whose-name-is-wider-than-37", undefined, [window({})])[0]).toBe(
        "a-provider-whose-name-is-wider-than-…",
      )
    })

    test("the strips: two windows 17 cells, three 11, one as wide as two; a fourth and on on the next line", () => {
      const strips = (width: number) => [1, 2, 3, 4, 5].map((count) => Object.values(usageStrips(width, count)))
      expect(strips(37)).toEqual([
        [1, 17],
        [2, 17],
        [3, 11],
        [3, 11],
        [3, 11],
      ])
      // Narrower: fewer on a line, none under 11 cells; one on the whole line once two don't fit.
      expect(strips(30)).toEqual([
        [1, 13],
        [2, 13],
        [2, 13],
        [2, 13],
        [2, 13],
      ])
      expect(strips(24)).toEqual([
        [1, 22],
        [1, 22],
        [1, 22],
        [1, 22],
        [1, 22],
      ])
      // Wider: never more than three on a line.
      expect(strips(50)).toEqual([
        [1, 23],
        [2, 23],
        [3, 15],
        [3, 15],
        [3, 15],
      ])
      const lengths = [18_000, 86_400, 604_800, 2_592_000, 7_776_000]
      const many = (count: number, width = 37) =>
        preview(
          section({
            accounts: [
              account("m", "codex", { windows: lengths.slice(0, count).map((seconds) => window({ seconds })) }),
            ],
            model: "gpt-6-luna",
            width,
          }),
        ).slice(1)
      expect(many(1)).toEqual(["Codex           5h                   ", "  ▒62%▒▒▒▒▒▒1h·20m·                  "])
      expect(many(4)).toEqual([
        "Codex     5h          1d          7d ",
        "         30d                         ",
        "  ▒62%▒▒▒·1h· ▒62%▒▒▒·1h· ▒62%▒▒▒·1h·",
        "  ▒62%▒▒▒·1h·                        ",
      ])
      expect(many(5)).toEqual([
        "Codex     5h          1d          7d ",
        "         30d         90d             ",
        "  ▒62%▒▒▒·1h· ▒62%▒▒▒·1h· ▒62%▒▒▒·1h·",
        "  ▒62%▒▒▒·1h· ▒62%▒▒▒·1h·            ",
      ])
      expect(many(3, 30)).toEqual([
        "Codex       5h            1d  ",
        "            7d                ",
        "  ▒62%▒▒▒▒··1h· ▒62%▒▒▒▒··1h· ",
        "  ▒62%▒▒▒▒··1h·               ",
      ])
    })

    describe("a strip (section 3)", () => {
      /** A codex account's only window as its strip: its text, its cells' backgrounds and its inks. */
      const strip = (extra: Partial<PacerWindow>, input: { now?: number; three?: boolean } = {}) => {
        const windows = input.three
          ? [window(extra), window({ ...SEVEN, ...extra }), window({ seconds: 2_592_000, ...extra })]
          : [window(extra)]
        const lines = section({
          accounts: [account("a", "codex", { windows })],
          model: "gpt-6-luna",
          now: input.now ?? NOW,
        })
        const [text, bg, ink] = grid(lines).at(-1)!
        const end = 2 + (input.three ? 11 : 17)
        return { text: text.slice(2, end), bg: bg.slice(2, end), ink: ink.slice(2, end) }
      }

      test("the fill is what is left, round(left / 100 × width) cells from the start; 100% all of it", () => {
        const fill = (left: number) => strip({ left }).bg
        expect(fill(100)).toBe("SSSSSSSSSSSSSSSSS")
        expect(fill(99)).toBe("SSSSSSSSSSSSSSSSS")
        expect(fill(97)).toBe("SSSSSSSSSSSSSSSST")
        expect(fill(50)).toBe("SSSSSSSSSTTTTTTTT")
        expect(fill(21)).toBe("SSSSTTTTTTTTTTTTT")
        expect(fill(3)).toBe("ETTTTTTTTTTTTTTTT")
        expect(fill(2)).toBe("TTTTTTTTTTTTTTTTT")
        expect(fill(0)).toBe("TTTTTTTTTTTTTTTTT")
      })

      test("the percent left at its start after a cell, bold, rounded down; <1% for a sliver; ? unknown, muted", () => {
        expect(strip({ left: 100 })).toMatchObject({ text: " 100%     1h 20m ", ink: " BBBB     bb bbb " })
        expect(strip({ left: 0 })).toMatchObject({ text: " 0%       1h 20m ", ink: " EE       bb bbb " })
        expect(strip({ left: 99.9 }).text).toBe(" 99%      1h 20m ")
        expect(strip({ left: 0.4 })).toMatchObject({ text: " <1%      1h 20m ", ink: " EEE      bb bbb " })
        expect(strip({ left: undefined, state: "partial" })).toEqual({
          text: " ?        1h 20m ",
          bg: "TTTTTTTTTTTTTTTTT",
          ink: " m        bb bbb ",
        })
      })

      test("the fill's tone and the percent's color: above 20% left, at 20% or less, at 10% or less", () => {
        const tone = (left: number) => {
          const cells = strip({ left })
          return `${cells.bg[0]}${cells.ink[1]}`
        }
        expect([100, 21, 20, 11, 10, 8].map(tone)).toEqual(["SB", "SB", "WW", "WW", "EE", "EE"])
      })

      test("muted, the percent in text color, while the reading isn't current; a dormant window is current", () => {
        const tone = (extra: Partial<PacerWindow>, now = NOW) => {
          const cells = strip({ left: 15, ...extra }, { now })
          return `${cells.bg[0]}${cells.ink[1]}`
        }
        expect(tone({ stale: true })).toBe("MB")
        expect(tone({ staleAt: NOW })).toBe("MB")
        expect(tone({ staleAt: NOW + 1 })).toBe("WW")
        expect(tone({ state: "awaiting-confirmation" })).toBe("MB")
        expect(tone({}, NOW + 80 * M)).toBe("MB")
        expect(tone({ state: "dormant", resetsAt: undefined })).toBe("WW")
        expect(tone({ state: "dormant", left: 100, resetsAt: undefined })).toBe("SB")
      })

      test("the time to the reset at its end, a cell before it: two units in strips of 15 cells or more, else one", () => {
        const time = (extra: Partial<PacerWindow>, three = false) => strip(extra, { three }).text
        expect(time({ resetsAt: NOW + 46 * M + 1 })).toBe(" 62%         47m ")
        expect(time({ resetsAt: NOW + 2 * H + 10 * M })).toBe(" 62%      2h 10m ")
        expect(time({ resetsAt: NOW + 2 * H })).toBe(" 62%          2h ")
        expect(time({ resetsAt: NOW + 6 * D + 23 * H })).toBe(" 62%      6d 23h ")
        expect(time({ resetsAt: NOW + 7 * D })).toBe(" 62%          7d ")
        expect(time({ resetsAt: NOW + 30_000 })).toBe(" 62%         <1m ")
        expect(time({ resetsAt: NOW + 6 * D + 23 * H, state: "estimated" })).toBe(" 62%     ~6d 23h ")
        expect(time({ resetsAt: NOW + 30_000, state: "estimated" })).toBe(" 62%        ~<1m ")
        // A window that starts with the next request; one whose reset passed with no reading since, or that CPP
        // waits to confirm; one without a known reset.
        expect(time({ left: 100, state: "dormant", resetsAt: undefined })).toBe(" 100%       idle ")
        expect(time({ resetsAt: NOW })).toBe(" 62%         now ")
        expect(time({ state: "awaiting-confirmation", resetsAt: undefined })).toBe(" 62%         now ")
        expect(time({ resetsAt: undefined, state: "partial" })).toBe(" 62%             ")
        // Three windows: 11 cells, one unit.
        expect(time({ resetsAt: NOW + 2 * H + 10 * M }, true)).toBe(" 62%    2h ")
        expect(time({ resetsAt: NOW + 6 * D + 23 * H, state: "estimated" }, true)).toBe(" 62%   ~6d ")
        expect(time({ resetsAt: NOW + 46 * M + 1 }, true)).toBe(" 62%   47m ")
        expect(time({ left: 100, state: "dormant", resetsAt: undefined }, true)).toBe(" 100% idle ")
        // The time keeps its color where the fill ends under it: text color, not bold.
        expect(strip({ left: 80, resetsAt: NOW + 6 * D + 23 * H })).toEqual({
          text: " 80%      6d 23h ",
          bg: "SSSSSSSSSSSSSSTTT",
          ink: " BBB      bb bbb ",
        })
      })

      test("a window an account lacks: an empty track, a faint – in its middle; none at all: no reading yet", () => {
        const accounts = [
          account("a", "claude", { windows: [window({}), window(SEVEN)] }),
          account("b", "claude", { windows: [window({})] }),
          account("c", "claude", { windows: [window(SEVEN)] }),
          account("d", "claude", { windows: [window({ scope: "sonnet" })] }),
        ]
        const out = section({ accounts })
        expect(preview(out).slice(1)).toEqual([
          "Claude          5h                7d ",
          "  ▒62%▒▒▒▒▒▒1h·20m· ▒62%▒▒▒▒▒▒1h·20m·",
          "  ▒62%▒▒▒▒▒▒1h 20m          –        ",
          "  ········–········ ▒62%▒▒▒▒▒▒1h·20m·",
          "  no reading yet                     ",
        ])
        expect(grid(out)[3]![2]).toBe("   BBB      bb bbb          f        ")
        expect(grid(out)[5]![2]).toBe("  mm mmmmmmm mmm                     ")
      })
    })

    test("a group with model groups: its name alone, a block per model group in order, the accounts in one order", () => {
      const ag = (alias: string, windows: PacerWindow[]) =>
        account(alias, "antigravity", { plan: "g1-pro-tier", planName: "Google AI Pro", windows })
      const both = (left: number) => [
        window({ scope: "claude_gpt", left }),
        window({ ...SEVEN, scope: "claude_gpt", left }),
        window({ scope: "gemini", left: 100 - left }),
        window({ ...SEVEN, scope: "gemini", left: 100 - left }),
      ]
      // Given out of order, one of them with Gemini's windows only.
      const accounts = [ag("ag-3", both(30)), ag("ag-1", both(90)), ag("ag-2", both(60).slice(2))]
      for (const model of ["claude-opus-5-5", "gemini-3-flash", "kimi-k3"]) {
        const out = section({ accounts, model })
        expect([model, texts(out)]).toEqual([
          model,
          [
            "Usage                                ",
            "Antigravity Google AI Pro            ",
            "Claude & GPT    5h                7d ",
            "   90%      1h 20m   90%      1h 20m ",
            "          –                 –        ",
            "   30%      1h 20m   30%      1h 20m ",
            "Gemini          5h                7d ",
            "   10%      1h 20m   10%      1h 20m ",
            "   40%      1h 20m   40%      1h 20m ",
            "   70%      1h 20m   70%      1h 20m ",
          ],
        ])
        // The model group's name in text, not bold; the group's in bold.
        expect(grid(out)[1]![2]).toBe("BBBBBBBBBBB BBBBBB BB BBB            ")
        expect(grid(out)[2]![2]).toBe("bbbbbb b bbb    mm                mm ")
      }
      // A model group none of the accounts has: no block.
      expect(heads(section({ accounts: [ag("ag-2", both(60).slice(2))], model: "gemini-3-flash" }))).toEqual([
        "Usage                                ",
        "Antigravity Google AI Pro            ",
        "Gemini          5h                7d ",
      ])
      // The other windows that limit the model: a block of their own, first, without a name, their scope named.
      const sonnet = ag("ag-1", [...both(90), window({ ...SEVEN, scope: "sonnet", left: 50 })])
      expect(texts(section({ accounts: [sonnet], model: "claude-sonnet-4-6" })).slice(1, 5)).toEqual([
        "Antigravity Google AI Pro            ",
        "         sonnet 7d                   ",
        "   50%      1h 20m                   ",
        "Claude & GPT    5h                7d ",
      ])
    })

    describe("the marks and the legend", () => {
      const pair = [
        account("a", "claude", { windows: [window({})] }),
        account("b", "claude", { windows: [window({})] }),
      ]
      const marks = (input: Omit<Partial<Parameters<typeof usageSection>[0]>, "accounts">, width = 37) => {
        const out = section({ accounts: pair, width, ...input })
        return {
          lines: preview(out).map((line) => line.trimEnd()),
          inks: grid(out).map((row) => row[2].trimEnd()),
        }
      }
      const view = chat({ model: "claude-opus-5-5", account: "a", accountID: "id-a" })

      test("● the chat's account: success while its step runs (in use), else info (last used); the legend", () => {
        expect(marks({ serving: pair[0], chat: view, running: true })).toEqual({
          lines: [
            "Usage                        ● in use",
            "Claude          5h",
            "● ▒62%▒▒▒▒▒▒1h·20m·",
            "  ▒62%▒▒▒▒▒▒1h 20m",
          ],
          inks: [
            "BBBBB                        s mm mmm",
            "BBBBBB          mm",
            "S  BBB      bb bbb",
            "   BBB      bb bbb",
          ],
        })
        expect(marks({ serving: pair[0], chat: view })).toMatchObject({
          lines: [
            "Usage                     ● last used",
            "Claude          5h",
            "● ▒62%▒▒▒▒▒▒1h·20m·",
            "  ▒62%▒▒▒▒▒▒1h 20m",
          ],
          inks: [
            "BBBBB                     i mmmm mmmm",
            "BBBBBB          mm",
            "I  BBB      bb bbb",
            "   BBB      bb bbb",
          ],
        })
      })

      test("› where the chat moves once its cache is cold, info; » where its next step moves now, warning; ●› ●»", () => {
        const next = marks({
          serving: pair[0],
          chat: chat({ ...view, nextUse: { account: "b", reason: "cold_move" } }),
        })
        expect(next.lines[0]).toBe("Usage             ● last used  › next")
        expect([next.lines[3], next.inks[3]]).toEqual(["› ▒62%▒▒▒▒▒▒1h 20m", "I  BBB      bb bbb"])
        const forced = chat({
          ...view,
          forceUse: { account: "b", when: "now" },
          nextUse: { account: "b", reason: "x" },
        })
        const moved = marks({ serving: pair[0], chat: forced, running: true })
        expect(moved.lines[0]).toBe("Usage              ● in use  » forced")
        expect([moved.lines[3], moved.inks[3]]).toEqual(["» ▒62%▒▒▒▒▒▒1h 20m", "W  BBB      bb bbb"])
        const stays = chat({ ...view, nextUse: { account: "a", reason: "cold_stay" } })
        expect(marks({ serving: pair[0], chat: stays, running: true })).toEqual({
          lines: [
            "Usage                ● in use  › next",
            "Claude          5h",
            "●›▒62%▒▒▒▒▒▒1h·20m·",
            "  ▒62%▒▒▒▒▒▒1h 20m",
          ],
          inks: [
            "BBBBB                s mm mmm  i mmmm",
            "BBBBBB          mm",
            "SI BBB      bb bbb",
            "   BBB      bb bbb",
          ],
        })
        const both = marks({ serving: pair[0], chat: chat({ ...view, forceUse: { account: "a", when: "now" } }) })
        expect([both.lines[2], both.inks[2]]).toEqual(["●»▒62%▒▒▒▒▒▒1h·20m·", "IW BBB      bb bbb"])
        // No view of the model (usageAccounts gives none): no marks, no legend.
        expect(marks({ serving: pair[0], chat: undefined }).lines.slice(0, 3)).toEqual([
          "Usage",
          "Claude          5h",
          "  ▒62%▒▒▒▒▒▒1h·20m·",
        ])
      })

      test("the legend on a line of its own under the groups when it doesn't fit beside the title", () => {
        const all = chat({
          ...view,
          nextUse: { account: "b", reason: "cold_move" },
          forceUse: { account: "b", when: "now" },
        })
        // At 37 the longest legend still fits: `● last used  › next` or `● last used  » forced`.
        expect(marks({ serving: pair[0], chat: all }).lines[0]).toBe("Usage           ● last used  » forced")
        const next = chat({ ...view, nextUse: { account: "b", reason: "cold_move" } })
        const narrow = marks({ serving: pair[0], chat: next }, 24)
        expect(narrow.lines).toEqual([
          "Usage",
          "Claude               5h",
          "● ▒62%▒▒▒▒▒▒▒▒▒▒·1h·20m·",
          "› ▒62%▒▒▒▒▒▒▒▒▒▒ 1h 20m",
          "● last used  › next",
        ])
        expect(narrow.inks.at(-1)).toBe("i mmmm mmmm  i mmmm")
      })

      test("in a group with model groups: on the account's row in the block of the model's group, the first for none", () => {
        // Each block's strip says which it is: Claude & GPT's 90% left, Gemini's 50%, the fable window's 20%.
        const pools = ["x", "y"].map((alias) =>
          account(alias, "antigravity", {
            windows: [
              window({ scope: "claude_gpt", left: 90 }),
              window({ scope: "gemini", left: 50 }),
              window({ ...SEVEN, scope: "fable", left: 20 }),
            ],
          }),
        )
        const where = (model: string) =>
          texts(
            section({
              accounts: pools,
              model,
              serving: pools[1],
              chat: chat({ model, account: "y", accountID: "id-y" }),
            }),
          ).flatMap((line, index) => (line.startsWith("●") ? [[index, line.trimEnd()]] : []))
        // The title, the group's name, then each block's label line over two rows.
        expect(where("claude-opus-5-5")).toEqual([[4, "●  90%      1h 20m"]])
        expect(where("gemini-3-flash")).toEqual([[7, "●  50%      1h 20m"]])
        // A model of neither group: the first block, here of the fable window that limits it, else Claude & GPT's.
        expect(where("kimi-fable-3")).toEqual([[4, "●  20%      1h 20m"]])
        expect(where("kimi-k3")).toEqual([[4, "●  90%      1h 20m"]])
      })
    })

    test("every other account a step quieter, the same account alike in every block", () => {
      const four = ["a", "b", "c", "d"].map((alias) =>
        account(alias, "antigravity", {
          windows: [window({ scope: "claude_gpt", left: 100 }), window({ scope: "gemini", left: 0 })],
        }),
      )
      expect(grid(section({ accounts: four, model: "gemini-3-flash" })).map((row) => row[1].slice(0, 19))).toEqual([
        "...................",
        "...................",
        "...................",
        "..SSSSSSSSSSSSSSSSS",
        "..sssssssssssssssss",
        "..SSSSSSSSSSSSSSSSS",
        "..sssssssssssssssss",
        "...................",
        "..TTTTTTTTTTTTTTTTT",
        "..ttttttttttttttttt",
        "..TTTTTTTTTTTTTTTTT",
        "..ttttttttttttttttt",
      ])
    })

    test("CLIProxyPacer unreachable: every line faint and dimmed, the fills muted, as of on the title line", () => {
      const view = chat({
        model: "claude-opus-5-5",
        account: "a",
        accountID: "id-a",
        nextUse: { account: "b", reason: "cold_move" },
      })
      const pair = [
        account("a", "claude", { plan: "claude_pro", windows: [window({ left: 15 })] }),
        account("b", "claude", {
          plan: "claude_pro",
          windows: [window({ left: 100, state: "dormant", resetsAt: undefined })],
        }),
      ]
      // As CPP last said, a minute ago.
      const out = section({ accounts: pair, serving: pair[0], chat: view, asOf: NOW - M, now: NOW - M })
      expect(grid(out)).toEqual([
        [
          "Usage                     as of 14:01",
          ".....................................",
          "FFFFF                     ff ff fffff",
        ],
        [
          "Claude Pro      5h                   ",
          ".....................................",
          "ffffff fff      ff                   ",
        ],
        [
          "●  15%      1h 21m                   ",
          "..MMMTTTTTTTTTTTTTT..................",
          "F  fff      ff fff                   ",
        ],
        [
          "›  100%       idle                   ",
          "..mmmmmmmmmmmmmmmmm..................",
          "F  ffff       ffff                   ",
        ],
      ])
      expect(out.flat().every((span) => span.dim === true)).toBe(true)
    })

    test("a proxy without the pacer: no pacer at the title's end, muted, nothing under it", () => {
      expect(grid(section({ accounts: [], noPacer: true }))).toEqual([
        [
          "Usage                        no pacer",
          ".....................................",
          "BBBBB                        mm mmmmm",
        ],
      ])
    })

    // The design (run/evidence/usage-redesign/design-2): proto.py's sample data and its screens, as preview.txt draws
    // them (▒ a fill, · a track, an alternate row's track blank) and compact.json colors them, cell by cell.
    describe("the design's screens", () => {
      const at = (left: number, ms: number, extra: Partial<PacerWindow> = {}) => ({
        left,
        resetsAt: NOW + ms,
        ...extra,
      })
      const IDLE = { left: 100, state: "dormant" as const, resetsAt: undefined }
      const claude = (alias: string, plan: Partial<PacerAccount>, windows: (Partial<PacerWindow> | null)[]) =>
        account(alias, "claude", {
          ...plan,
          windows: windows.flatMap((extra, index) =>
            extra === null ? [] : [window({ ...(index === 1 ? SEVEN : {}), ...extra })],
          ),
        })
      const ULTRA = { plan: "default_claude_max_20x", planName: "Ultra" }
      const PRO = { plan: "claude_pro" }
      const CLAUDE = [
        claude("ultra-1", ULTRA, [null, at(0, 2 * D + 2 * H + 14 * M)]),
        claude("ultra-2", ULTRA, [at(88, 22 * M), at(71, 5 * D + 2 * H)]),
        claude("ultra-3", ULTRA, [null, at(100, 6 * D + 16 * H)]),
        claude("pro-1", PRO, [IDLE, at(1, D + 14 * H)]),
        claude("pro-2", PRO, [IDLE, at(86, 6 * D + 2 * H)]),
        claude("pro-3", PRO, [at(96, 3 * H + 24 * M), at(71, 2 * D + 7 * H)]),
      ]
      const pool = (alias: string, windows: Partial<PacerWindow>[]) =>
        account(alias, "antigravity", {
          plan: "g1-pro-tier",
          planName: "Google AI Pro",
          windows: windows.map((extra, index) =>
            window({ ...(index % 2 === 1 ? SEVEN : {}), scope: index < 2 ? "claude_gpt" : "gemini", ...extra }),
          ),
        })
      const ANTIGRAVITY = [
        pool("ag-1", [IDLE, at(97, 6 * D + 23 * H, { state: "estimated" }), IDLE, at(100, 7 * D)]),
        pool("ag-2", [at(62, 2 * H + 10 * M), at(81, 5 * D + 4 * H), IDLE, at(93, 5 * D + 4 * H)]),
        pool("ag-3", [at(14, 47 * M), at(38, 3 * D + 9 * H), at(88, 4 * H + 2 * M), at(71, 3 * D + 9 * H)]),
      ]

      test("antigravity-claude: Antigravity's rows by model group, then the Claude plans", () => {
        const out = section({ accounts: [...CLAUDE, ...ANTIGRAVITY], model: "claude-sonnet-4-6" })
        expect(preview(out)).toEqual([
          "Usage                                ",
          "Antigravity Google AI Pro            ",
          "Claude & GPT    5h                7d ",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ▒97%▒▒▒▒▒~6d▒23h·",
          "  ▒62%▒▒▒▒▒▒2h 10m  ▒81%▒▒▒▒▒▒▒5d▒4h ",
          "  ▒14%·········47m· ▒38%▒▒·····3d·9h·",
          "Gemini          5h                7d ",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ▒100%▒▒▒▒▒▒▒▒▒7d▒",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ▒93%▒▒▒▒▒▒▒5d▒4h ",
          "  ▒88%▒▒▒▒▒▒▒4h▒2m· ▒71%▒▒▒▒▒▒▒3d·9h·",
          "Claude Ultra    5h                7d ",
          "  ········–········ ·0%········2d·2h·",
          "  ▒88%▒▒▒▒▒▒▒▒▒22m  ▒71%▒▒▒▒▒▒▒5d 2h ",
          "  ········–········ ▒100%▒▒▒▒▒6d▒16h▒",
          "Claude Pro      5h                7d ",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ·1%·······1d·14h·",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ▒86%▒▒▒▒▒▒▒6d▒2h ",
          "  ▒96%▒▒▒▒▒▒3h▒24m· ▒71%▒▒▒▒▒▒▒2d·7h·",
        ])
        expect(grid(out).map((row) => row.slice(1))).toEqual([
          [".....................................", "BBBBB                                "],
          [".....................................", "BBBBBBBBBBB BBBBBB BB BBB            "],
          [".....................................", "bbbbbb b bbb    mm                mm "],
          ["..SSSSSSSSSSSSSSSSS.SSSSSSSSSSSSSSSST", "   BBBB       bbbb   BBB     bbb bbb "],
          ["..ssssssssssstttttt.ssssssssssssssttt", "   BBB      bb bbb   BBB       bb bb "],
          ["..WWTTTTTTTTTTTTTTT.SSSSSSTTTTTTTTTTT", "   WWW         bbb   BBB       bb bb "],
          [".....................................", "bbbbbb          mm                mm "],
          ["..SSSSSSSSSSSSSSSSS.SSSSSSSSSSSSSSSSS", "   BBBB       bbbb   BBBB         bb "],
          ["..sssssssssssssssss.sssssssssssssssst", "   BBBB       bbbb   BBB       bb bb "],
          ["..SSSSSSSSSSSSSSSTT.SSSSSSSSSSSSTTTTT", "   BBB       bb bb   BBB       bb bb "],
          [".....................................", "BBBBBB BBBBB    mm                mm "],
          ["..TTTTTTTTTTTTTTTTT.TTTTTTTTTTTTTTTTT", "          f          EE        bb bb "],
          ["..ssssssssssssssstt.ssssssssssssttttt", "   BBB         bbb   BBB       bb bb "],
          ["..TTTTTTTTTTTTTTTTT.SSSSSSSSSSSSSSSSS", "          f          BBBB     bb bbb "],
          [".....................................", "BBBBBB BBB      mm                mm "],
          ["..SSSSSSSSSSSSSSSSS.TTTTTTTTTTTTTTTTT", "   BBBB       bbbb   EE       bb bbb "],
          ["..sssssssssssssssss.ssssssssssssssstt", "   BBBB       bbbb   BBB       bb bb "],
          ["..SSSSSSSSSSSSSSSST.SSSSSSSSSSSSTTTTT", "   BBB      bb bbb   BBB       bb bb "],
        ])
      })

      test("claude-running: the chat's account in use, its next use, the legend on the title line", () => {
        const view = chat({
          model: "claude-opus-5-5",
          account: "ultra-2",
          accountID: "id-ultra-2",
          nextUse: { account: "pro-3", reason: "cold_move" },
        })
        const out = section({ accounts: CLAUDE, serving: CLAUDE[1], chat: view, running: true })
        expect(preview(out)).toEqual([
          "Usage                ● in use  › next",
          "Claude Ultra    5h                7d ",
          "  ········–········ ·0%········2d·2h·",
          "● ▒88%▒▒▒▒▒▒▒▒▒22m  ▒71%▒▒▒▒▒▒▒5d 2h ",
          "  ········–········ ▒100%▒▒▒▒▒6d▒16h▒",
          "Claude Pro      5h                7d ",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ·1%·······1d·14h·",
          "  ▒100%▒▒▒▒▒▒▒idle▒ ▒86%▒▒▒▒▒▒▒6d▒2h ",
          "› ▒96%▒▒▒▒▒▒3h▒24m· ▒71%▒▒▒▒▒▒▒2d·7h·",
        ])
        expect(grid(out).map((row) => row[2])).toEqual([
          "BBBBB                s mm mmm  i mmmm",
          "BBBBBB BBBBB    mm                mm ",
          "          f          EE        bb bb ",
          "S  BBB         bbb   BBB       bb bb ",
          "          f          BBBB     bb bbb ",
          "BBBBBB BBB      mm                mm ",
          "   BBBB       bbbb   EE       bb bbb ",
          "   BBBB       bbbb   BBB       bb bb ",
          "I  BBB      bb bbb   BBB       bb bb ",
        ])
      })

      test("command-3: three windows of 11 cells, one unit; a reset passed, none known, a sliver", () => {
        const goat = (alias: string, windows: Partial<PacerWindow>[]) =>
          account(alias, "commandcode", {
            plan: "individual-goat",
            windows: windows.map((extra, index) => window({ seconds: [18_000, 604_800, 2_592_000][index]!, ...extra })),
          })
        const PASSED = { state: "awaiting-confirmation" as const, resetsAt: undefined, stale: true }
        const PARTIAL = { state: "partial" as const, resetsAt: undefined }
        const accounts = [
          goat("goat-1", [{ left: 100, ...PASSED }, at(90.2, 6 * D + 3 * H), { left: 45.1, ...PARTIAL }]),
          goat("goat-2", [IDLE, { left: 0.02, ...PASSED }, { left: 0, ...PARTIAL }]),
          goat("goat-3", [at(72, 3 * H + 10 * M), at(65.7, D + 20 * H), { left: 32.8, ...PARTIAL }]),
          goat("goat-4", [IDLE, at(90.1, 5 * D + 19 * H), { left: 52.7, ...PARTIAL }]),
          goat("goat-5", [IDLE, at(18, 28 * M), { left: 50, ...PARTIAL }]),
          account("key-1", "commandcode", {
            windows: [window(at(99, H + 5 * M)), window({ ...SEVEN, ...at(75, 2 * D + 4 * H) })],
          }),
        ]
        const view = chat({
          model: "gpt-6-luna",
          account: "goat-3",
          accountID: "id-goat-3",
          nextUse: { account: "goat-5", reason: "cold_move" },
        })
        const out = section({ accounts, model: "gpt-6-luna", serving: accounts[2], chat: view, running: true })
        expect(preview(out)).toEqual([
          "Usage                ● in use  › next",
          "Command Code GOAT                    ",
          "          5h          7d         30d ",
          "  ▒100%▒▒now▒ ▒90%▒▒▒▒6d· ▒45%▒······",
          "  ▒100%▒idle▒  <1%   now   0%        ",
          "● ▒72%▒▒▒▒3h· ▒65%▒▒▒·1d· ▒32%·······",
          "  ▒100%▒idle▒ ▒90%▒▒▒▒5d  ▒52%▒▒     ",
          "› ▒100%▒idle▒ ▒18%···28m· ▒50%▒▒·····",
          "Command Code    5h                7d ",
          "  ▒99%▒▒▒▒▒▒▒1h▒5m▒ ▒75%▒▒▒▒▒▒▒2d·4h·",
        ])
        expect(grid(out).map((row) => row[1])).toEqual([
          ".....................................",
          ".....................................",
          ".....................................",
          "..MMMMMMMMMMM.SSSSSSSSSST.SSSSSTTTTTT",
          "..sssssssssss.ttttttttttt.ttttttttttt",
          "..SSSSSSSSTTT.SSSSSSSTTTT.SSSSTTTTTTT",
          "..sssssssssss.sssssssssst.ssssssttttt",
          "..SSSSSSSSSSS.WWTTTTTTTTT.SSSSSSTTTTT",
          ".....................................",
          "..SSSSSSSSSSSSSSSSS.SSSSSSSSSSSSSTTTT",
        ])
      })
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
