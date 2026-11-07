import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Pacer } from "@opencode/schema/pacer"
import { SessionID } from "@opencode/schema/session-id"
import { PacerWire } from "@opencode/core/pacer/wire"

// Synthetic answers in CPP's shapes; no real account, alias, ID or price.
const sessionID = SessionID.make("ses_wire_test")
const decodeView = Schema.decodeUnknownSync(PacerWire.View)
const hour = 3_600_000

describe("PacerWire", () => {
  test("turns a view into the chat's shape, on the service's clock", () => {
    const view = decodeView({
      id: "uuid-a",
      session_id: 7,
      account: "auth-a",
      provider: "prova",
      model: "model-a",
      warm: true,
      warm_until: 10_000_000,
      pings: {
        active: true,
        next_ping_at: 9_900_000,
        pings_left: 2,
        pings_sent: 1,
        interval_ms: 240_000,
        stopped: null,
      },
      effective: { pings_enabled: true, compact_before_cold: true, compact_cold_first: true },
      warming: {
        cold: false,
        size_tokens: 82_000,
        threshold: 70_000,
        compact_at: 9_800_000,
        compact_reason: "before-cold",
      },
      next_use: { credential: "account-b", reason: "forced_move", window_values: [] },
      force_use: { credential: "account-b", when: "soon" },
      label: null,
      unknown_field: { ignored: true },
    })
    const chat = PacerWire.chat(view, sessionID, { offset: 5_000, now: 1, alias: (account) => `alias of ${account}` })
    expect(chat).toEqual({
      sessionID,
      model: "model-a",
      provider: "prova",
      account: "alias of auth-a",
      accountID: "auth-a",
      warm: true,
      warmUntil: 9_995_000,
      coldAt: 9_995_000 + 2 * 240_000,
      pings: { active: true, nextAt: 9_895_000, left: 2, sent: 1, intervalMs: 240_000, failed: false },
      compactAt: 9_795_000,
      compactReason: "before-cold",
      nextUse: { account: "alias of account-b", reason: "forced_move" },
      forceUse: { account: "alias of account-b", when: "soon" },
      switches: { warming: true, compactBeforeCold: true, compactColdFirst: true },
      size: { tokens: 82_000, threshold: 70_000 },
      asOf: 1,
    })
  })

  test("tells the chat's size only while CPP knows it, and each switch only when CPP's value for the chat is on", () => {
    const at = (fields: Record<string, unknown>) =>
      PacerWire.chat(decodeView({ id: "uuid-a", ...fields }), sessionID, { offset: 0, now: 0, alias: (a) => a })
    // CPP's size is null until the chat has an answered step; the threshold is always there.
    expect(at({ warming: { cold: false, size_tokens: null, threshold: 70_000 } }).size).toBeUndefined()
    expect(at({ warming: { cold: true, size_tokens: 1_000, threshold: 500 } }).size).toEqual({
      tokens: 1_000,
      threshold: 500,
    })
    expect(at({}).switches).toEqual({ warming: false, compactBeforeCold: false, compactColdFirst: false })
    // A value CPP could not read as a flag is not on.
    expect(at({ effective: { compact_cold_first: "true", compact_before_cold: null } }).switches).toEqual({
      warming: false,
      compactBeforeCold: false,
      compactColdFirst: false,
    })
  })

  test("reads the compaction asks for all chats from CPP's settings listing: what applies to the key", () => {
    // `GET|PATCH /pacer/v1/settings` (cpa-pacer settings.rs, `settings_listing`): one row per setting the key may set.
    const row = (name: string, server: unknown, key: unknown, value: unknown, source: string) => ({
      name,
      group: "warming",
      type: "bool",
      help: "synthetic",
      server,
      key,
      value,
      source,
    })
    const listing = Schema.decodeUnknownSync(PacerWire.Settings)([
      row("pings.enabled", null, null, true, "default"),
      row("warming.compact_before_cold", true, null, true, "server"),
      row("warming.compact_cold_first", null, false, false, "key"),
      { name: "a row this version does not understand" },
      "not a row",
    ])
    expect(PacerWire.settings(listing)).toEqual({ compactColdFirst: false, compactBeforeCold: true })
    expect(
      PacerWire.settings(
        Schema.decodeUnknownSync(PacerWire.Settings)([row("warming.compact_cold_first", false, true, true, "key")]),
      ),
    ).toEqual({ compactColdFirst: true, compactBeforeCold: false })
    // A CPP that lists neither: both off, as their defaults.
    expect(PacerWire.settings([])).toEqual({ compactColdFirst: false, compactBeforeCold: false })
  })

  test("counts down to warm_until when no pings are planned, and marks pings that ended on a failure", () => {
    const chat = PacerWire.chat(
      decodeView({ id: "uuid-a", warm: true, warm_until: 500, pings: { active: false, stopped: "floored" } }),
      sessionID,
      { offset: 0, now: 0, alias: (account) => account },
    )
    expect(chat.coldAt).toBe(500)
    expect(chat.pings).toEqual({ active: false, left: 0, sent: 0, stopped: "floored", failed: true })
    const cold = PacerWire.chat(decodeView({ id: "uuid-a", warm: false, warm_until: 500 }), sessionID, {
      offset: 0,
      now: 0,
      alias: (account) => account,
    })
    expect(cold.coldAt).toBeUndefined()
  })

  test("counts no pings with warming off, though CPP's answer to the write still lists them planned", () => {
    // CPP's answer to {"pings.enabled": false} on the owner's CPP (run/evidence/v0.0.7/live-owner-4): the switch off,
    // the pings still active with 8 left, about a second before its list says they stopped.
    const answered = (enabled: boolean) =>
      PacerWire.chat(
        decodeView({
          id: "uuid-a",
          warm: true,
          warm_until: 500,
          pings: { active: true, pings_left: 8, interval_ms: 285_000 },
          effective: { pings_enabled: enabled },
        }),
        sessionID,
        { offset: 0, now: 0, alias: (account) => account },
      )
    expect(answered(false)).toMatchObject({ coldAt: 500, switches: { warming: false } })
    expect(answered(true)).toMatchObject({ coldAt: 500 + 8 * 285_000, switches: { warming: true } })
  })

  test("keeps the windows that apply, named with their scope, and stale after an hour or without a reading", () => {
    const now = 10 * hour
    const meters = PacerWire.meters([
      {
        auth_index: "auth-a",
        provider: "prova",
        label: "account-a",
        windows: [
          {
            scope: "all",
            seconds: 18_000,
            left: 40,
            reset: now + hour,
            usage_at: now - 30 * 60_000,
            label: "5h",
            state: "estimated",
          },
          {
            scope: "opus",
            seconds: 604_800,
            left: 80,
            reset: now + 24 * hour,
            usage_at: now - 2 * hour,
            label: "7d",
            state: "current",
          },
          {
            scope: "all",
            seconds: 604_800,
            left: null,
            reset: 0,
            usage_at: 0,
            label: "7d",
            state: "awaiting-confirmation",
          },
          { scope: "all", seconds: 2_592_000, left: null, reset: 0, state: "not-applicable", not_applicable: true },
          { scope: "all", seconds: 5_400, left: 101, reset: 0, state: "made-up" },
        ],
      },
      { provider: "no index" },
    ])
    const accounts = PacerWire.accounts(meters, { offset: 0, now })
    expect(accounts.items).toHaveLength(1)
    expect(accounts.items[0]).toMatchObject({ id: meters[0].auth_index })
    expect(accounts.items[0].windows.map((window) => [window.label, window.state, window.stale])).toEqual([
      ["5h", "estimated", false],
      ["7d opus", "current", true],
      ["7d", "awaiting-confirmation", true],
      ["90m", "unknown", true],
    ])
    expect(accounts.items[0].windows[0]).toMatchObject({ left: 40, resetsAt: now + hour, staleAt: now + 30 * 60_000 })
    expect(accounts.items[0].windows[3].left).toBe(100)
  })

  test("turns a request row into openforge's shape", () => {
    const [row] = PacerWire.rows([
      {
        id: 3,
        at: 2_000,
        ext: "req-3",
        provider: "prova",
        model: "upstream-a",
        alias: "model-a",
        kind: 1,
        status: 200,
        failed: false,
        input: 1,
        output: 2,
        reasoning: 3,
        cache_read: 4,
        cache_write_5m: 5,
        cache_write_1h: 6,
        cache_write_other: 7,
        cost_api: 2_500_000_000,
        cache_verdict: "partial",
        cache_cause: "tools changed",
        cache_shortfall: 900,
        miss_cost: 500_000_000,
        changed_part: "tools[0]",
        session_ext: "uuid-a",
        subagent: true,
        account: "account-a",
      },
    ])
    expect(PacerWire.request(row, { sessionID, agent: "explore" }, { offset: 500, now: 0 })).toEqual({
      id: "req-3",
      at: 1_500,
      sessionID,
      subagent: true,
      agent: Agent.ID.make("explore"),
      kind: "ping",
      model: "model-a",
      provider: "prova",
      account: "account-a",
      status: 200,
      failed: false,
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 18 },
      cost: Money.USD.make(2.5),
      verdict: "partial",
      miss: true,
      cause: "tools changed",
      changedPart: "tools[0]",
      rewritten: 900,
      missCost: Money.USD.make(0.5),
    })
    const [refused] = PacerWire.rows([
      { id: 4, at: 1, ext: "req-4", kind: 9, status: 429, failed: true, refusal: "accounts_quota" },
    ])
    expect(PacerWire.request(refused, {}, { offset: 0, now: 0 })).toMatchObject({
      kind: "other",
      failed: true,
      refusal: "accounts_quota",
      miss: false,
    })
  })

  test("a row without a request ID, as CPP records a web tool call, goes by its row; one with an ID keeps it", () => {
    // Spec cliproxypacer-step-2, the decision of 2026-11-07: every such row of a chat went by the same empty ID.
    const rows = PacerWire.rows([
      { id: 41, at: 1, ext: "", kind: 6, alias: "web_search", provider: "exa" },
      { id: 42, at: 2, ext: "", kind: 6, alias: "web_research", provider: "exa" },
      { id: 43, at: 3, ext: "0b6d1c52-5e0a-4f8e-9a51-2c4b7f1d9e30", kind: 0 },
    ])
    const shaped = rows.map((row) => PacerWire.request(row, {}, { offset: 0, now: 0 }))
    expect(shaped.map((request) => [request.id, request.kind, request.model])).toEqual([
      ["row:41", "search", "web_search"],
      ["row:42", "search", "web_research"],
      ["0b6d1c52-5e0a-4f8e-9a51-2c4b7f1d9e30", "step", ""],
    ])
    expect(shaped.map((request) => Pacer.promptless(request.id))).toEqual([true, true, false])
    expect(PacerWire.requestID(rows[0])).toBe(Pacer.rowRequestID(41))
  })

  test("says what changed in a prompt, and whether CPP still holds it", () => {
    const [request] = PacerWire.rows([{ id: 3, at: 1, ext: "req-3" }])
    const shaped = PacerWire.request(request, {}, { offset: 0, now: 0 })
    const prompt = Schema.decodeUnknownSync(PacerWire.Prompt)({
      kept: false,
      previous: 2,
      removed: ["messages[9]"],
      rows: [
        { path: "model", kind: "option", summary: "model", chars: 5, change: "same" },
        // Claude Code's billing block, new on every request; the cache counts it as no change (CPP 2026-11-06).
        { path: "system[0]", kind: "system", summary: "x-anthropic-billing-header: …", chars: 80, change: "billing" },
        { path: "messages[1]", kind: "dropped", chars: 50, change: "changed" },
        { path: "messages[2]", kind: "result", summary: "error", chars: 9, change: "new", error: true },
        { path: "messages[3]", kind: "prompt", summary: "hi", chars: 2, change: "marker", marker: true },
      ],
    })
    // The request it was compared with comes on the service's clock, at the time the connection holds for it.
    expect(PacerWire.promptChange(prompt, shaped, { id: "req-2", at: 800 }, { offset: 100, now: 7 })).toEqual({
      request: shaped,
      comparedWith: { id: "req-2", at: 800 },
      kept: "part",
      items: [
        { path: "messages[1]", kind: "dropped", summary: "", chars: 50, change: "changed", error: false },
        { path: "messages[2]", kind: "result", summary: "error", chars: 9, change: "new", error: true },
        { path: "messages[3]", kind: "prompt", summary: "hi", chars: 2, change: "marker", error: false },
      ],
      removed: ["messages[9]"],
      unchanged: 2,
      asOf: 7,
    })
    expect(PacerWire.promptChange(undefined, shaped, undefined, { offset: 0, now: 0 })).toMatchObject({
      kept: "none",
      items: [],
      unchanged: 0,
    })
  })

  test("reads what a compact notice names", () => {
    expect(
      PacerWire.notice(JSON.stringify({ kind: "compact", sessions: [{ key: 1, session: "UUID-A" }], at: 1 })),
    ).toEqual({
      sessions: ["uuid-a"],
      many: false,
    })
    expect(PacerWire.notice(JSON.stringify({ kind: "compact", sessions: [], many: true, at: 1 }))).toEqual({
      sessions: [],
      many: true,
    })
    expect(PacerWire.notice("not json")).toEqual({ sessions: [], many: false })
  })
})
