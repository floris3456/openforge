import { describe, expect, test } from "bun:test"
import type { PacerRequest, PacerWindow } from "@opencode/client"
import { mergeFirst } from "../../src/context/pacer"
import {
  cacheLabel,
  cacheText,
  forceUseLine,
  formatRemaining,
  remainingHours,
  formatReset,
  nextUseLine,
  promptChangeLines,
  requestColumns,
  requestRow,
  requestTone,
  windowLine,
} from "../../src/pacer/format"
import { requestTarget } from "../../src/pacer/jump"
import { listTop } from "../../src/routes/session/composer/requests-tab"
import { chat, miss, NOW, promptChange, request, step } from "./fixture"

// Written from spec cliproxypacer-step-1: section 4's table, section 5's texts and section 7's rows, Enter and
// what changed.

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
      switches: { warming: false, compactBeforeCold: false },
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
      switches: { warming: true, compactBeforeCold: true },
      compactAt: new Date(2026, 10, 6, 14, 32).getTime(),
      compactReason: "before-cold",
    })
    expect(text(view)).toEqual({ text: "compacts at 14:32", tone: "muted" })
    // On, but not due: the countdown.
    expect(text(chat({ switches: { warming: true, compactBeforeCold: true } })).text).toBe("warm 23:41")
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

describe("the sidebar's Account section (section 5)", () => {
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

  test("each window, with what is left and when it resets", () => {
    expect(windowLine(window({}), NOW)).toBe("5h  62% left · resets 1:20")
    expect(windowLine(window({ label: "7d opus", left: 80.4, resetsAt: NOW + 76 * 3_600_000 }), NOW)).toBe(
      "7d opus  80% left · resets 3d 4h",
    )
  })

  test("marked when CPP calls it estimated or stale", () => {
    expect(windowLine(window({ state: "estimated" }), NOW)).toBe("5h  62% left · resets ~1:20")
    expect(windowLine(window({ state: "estimated", stale: true }), NOW)).toBe("5h  62% left · resets ~1:20 · stale")
    expect(windowLine(window({ stale: true }), NOW)).toBe("5h  62% left · resets 1:20 · stale")
    // A reading turns stale an hour after it was read, without anything new being sent.
    expect(windowLine(window({ staleAt: NOW + 1000 }), NOW)).toBe("5h  62% left · resets 1:20")
    expect(windowLine(window({ staleAt: NOW + 1000 }), NOW + 1000)).toBe("5h  62% left · resets 1:20 · stale")
  })

  test("windows CPP knows less of", () => {
    expect(windowLine(window({ state: "dormant", left: 100 }), NOW)).toBe("5h  100% left · not started")
    expect(windowLine(window({ state: "unknown", left: undefined, resetsAt: undefined, stale: true }), NOW)).toBe(
      "5h  unknown · stale",
    )
    expect(windowLine(window({ state: "awaiting-confirmation", stale: true }), NOW)).toBe(
      "5h  62% left · reset, awaiting a reading · stale",
    )
    expect(formatReset(30_000)).toBe("0:01")
  })

  test("where the chat goes next once its cache is cold, and why", () => {
    expect(nextUseLine({ account: "max-1", reason: "cold_move" })).toBe("next: max-1, once its cache is cold")
    expect(nextUseLine({ account: "max-1", reason: "forced_move" })).toBe("next: max-1, its account can't keep it")
  })

  test("a forced move, now or soon", () => {
    expect(forceUseLine({ account: "max-1", when: "now" })).toBe("forced move to max-1 now")
    expect(forceUseLine({ account: "max-1", when: "soon" })).toBe("forced move to max-1 soon")
  })
})

describe("a row of the Requests tab (section 7)", () => {
  const at = new Date(2026, 10, 6, 14, 2, 13).getTime()
  const row = (extra: Partial<PacerRequest>, width = 110) => requestRow(request(0, { at, ...extra }), width)
  const cells = (text: string) => text.split(/\s{2,}/).filter(Boolean)

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
    const text = requestRow(miss(0, { at }), 110)
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

  test("a narrow window drops the model, then the account, then the cache, and keeps the verdict and the cost", () => {
    expect(requestColumns(110)).toEqual({ cache: true, account: true, model: 18, verdict: 31 })
    expect(requestColumns(90)).toEqual({ cache: true, account: true, model: 0, verdict: 31 })
    expect(requestColumns(80)).toEqual({ cache: true, account: false, model: 0, verdict: 35 })
    expect(requestColumns(60)).toEqual({ cache: false, account: false, model: 0, verdict: 29 })
    expect(cells(row({}, 90))).toEqual(["14:02:13", "step", "max-2", "120.3K/1.2K", "hit", "$0.0123"])
    expect(cells(row({}, 80))).toEqual(["14:02:13", "step", "120.3K/1.2K", "hit", "$0.0123"])
    const narrow = requestRow(miss(0, { at }), 61)
    expect(narrow).toHaveLength(61)
    expect(cells(narrow)).toEqual(["14:02:13", "step", "miss · prefix changed · system", "$0.0123"])
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
      "CPP kept only fingerprints of some items",
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

  test("the first row on screen stays where it was unless the selection would leave the screen", () => {
    // At the top, a new row above the selection shows; the selection keeps its request.
    expect(listTop(0, 1, 6, 10)).toBe(0)
    // Selected on the last line: the new row stays above the screen, nothing on screen moves.
    expect(listTop(0, 6, 6, 10)).toBe(1)
    expect(listTop(4, 2, 6, 10)).toBe(2)
    expect(listTop(9, 9, 6, 10)).toBe(4)
  })
})
