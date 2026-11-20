import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"
import { EventManifest } from "../src/event-manifest.js"
import { Money } from "../src/money.js"
import { Pacer } from "../src/pacer.js"
import { SessionID } from "../src/session-id.js"

const sessionID = SessionID.make("ses_pacer_test")

const chat: Pacer.Chat = {
  sessionID,
  model: "model-a",
  provider: "provider-a",
  account: "account-a",
  warm: true,
  warmUntil: 1_000_000,
  coldAt: 1_900_000,
  pings: { active: true, nextAt: 1_000_000, left: 3, sent: 1, intervalMs: 300_000, failed: false },
  nextUse: { account: "account-b", reason: "cold_move" },
  switches: { warming: true, compactBeforeCold: false, compactColdFirst: true },
  size: { tokens: 82_000, threshold: 70_000 },
  asOf: 990_000,
}

const request: Pacer.Request = {
  id: "req-1",
  at: 980_000,
  sessionID,
  subagent: false,
  kind: "step",
  model: "model-a",
  provider: "provider-a",
  account: "account-a",
  status: 200,
  failed: false,
  tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 1_000, cacheWrite: 30 },
  verdict: "partial",
  miss: true,
  cause: "tools changed",
  rewritten: 400,
}

describe("pacer shapes", () => {
  test("keeps the pacer events public, canonical, and ephemeral", () => {
    expect(Pacer.Event.Definitions.map((definition) => definition.type)).toEqual([
      "pacer.status",
      "pacer.accounts.updated",
      "pacer.logins.ready",
      "pacer.models.updated",
      "pacer.chat.updated",
      "pacer.requests.updated",
      "pacer.notice.added",
      "pacer.notice.dismissed",
      "pacer.attention.raised",
    ])
    for (const definition of Pacer.Event.Definitions) {
      expect(EventManifest.ServerDefinitions).toContain(definition)
      expect(EventManifest.Definitions).toContain(definition)
      expect(EventManifest.Server.get(definition.type)).toBe(definition)
      expect(EventManifest.Latest.get(definition.type)).toBe(definition)
      expect(definition.durability).toBe("ephemeral")
      expect(EventManifest.Durable.has(definition.type)).toBe(false)
    }
  })

  test("a chat encodes without its absent fields and decodes back", () => {
    const encoded = Schema.encodeSync(Pacer.Chat)(chat)
    expect(encoded).not.toHaveProperty("compactAt")
    expect(encoded).not.toHaveProperty("forceUse")
    expect(encoded.pings).not.toHaveProperty("stopped")
    expect(Schema.decodeUnknownSync(Pacer.Chat)(JSON.parse(JSON.stringify(encoded)))).toEqual(chat)
  })

  test("a request row and what changed in its prompt decode", () => {
    const change: Pacer.PromptChange = {
      request,
      comparedWith: { id: "req-0", at: 970_000 },
      kept: "part",
      items: [
        { path: "tools[2]", kind: "tool", summary: "a tool", chars: 120, change: "changed", error: false },
        { path: "messages[4]", kind: "prompt", summary: "", chars: 0, change: "new", error: false },
      ],
      removed: ["messages[9]"],
      unchanged: 12,
      asOf: 990_000,
    }
    expect(Schema.decodeUnknownSync(Pacer.PromptChange)(Schema.encodeSync(Pacer.PromptChange)(change))).toEqual(change)
    const page: Pacer.Requests = { items: [request], cursor: "opaque", asOf: 990_000 }
    expect(Schema.decodeUnknownSync(Pacer.Requests)(Schema.encodeSync(Pacer.Requests)(page))).toEqual(page)
  })

  test("rejects values outside the shapes", () => {
    const window: Pacer.Window = {
      label: "5h",
      scope: "all",
      seconds: 18_000,
      left: 62,
      resetsAt: 2_000_000,
      readAt: 990_000,
      state: "current",
      stale: false,
      staleAt: 4_590_000,
    }
    expect(Schema.decodeUnknownSync(Pacer.Window)(window)).toEqual(window)
    expect(() => Schema.decodeUnknownSync(Pacer.Window)({ ...window, left: 101 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Window)({ ...window, state: "stale" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Request)({ ...request, kind: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Status)({ state: "off", since: 0, refused: false })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Chat)({ ...chat, size: { tokens: -1, threshold: 70_000 } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Chat)({ ...chat, size: { tokens: 82_000 } })).toThrow()
  })

  test("the compaction asks for all chats, and a change to them, decode; an absent ask stays as it is", () => {
    const settings: Pacer.Settings = { compactColdFirst: true, compactBeforeCold: false }
    expect(Schema.decodeUnknownSync(Pacer.Settings)(Schema.encodeSync(Pacer.Settings)(settings))).toEqual(settings)
    expect(() => Schema.decodeUnknownSync(Pacer.Settings)({ compactColdFirst: true })).toThrow()
    expect(Schema.decodeUnknownSync(Pacer.SettingsUpdate)({ compactColdFirst: false })).toEqual({
      compactColdFirst: false,
    })
    expect(Schema.decodeUnknownSync(Pacer.SettingsUpdate)({})).toEqual({})
    expect(() => Schema.decodeUnknownSync(Pacer.SettingsUpdate)({ compactColdFirst: "on" })).toThrow()
    expect(Schema.decodeUnknownSync(Pacer.ChatUpdate)({ compactColdFirst: true })).toEqual({ compactColdFirst: true })
  })

  // Spec cliproxypacer-server-summaries, section 2.
  test("who writes the summaries and whether they keep your messages, for all chats: decode, absent while unknown", () => {
    const settings: Pacer.Settings = {
      compactColdFirst: false,
      compactBeforeCold: false,
      summaryWriter: "cliproxypacer",
      keepUserMessages: true,
    }
    expect(Schema.decodeUnknownSync(Pacer.Settings)(Schema.encodeSync(Pacer.Settings)(settings))).toEqual(settings)
    expect(Schema.decodeUnknownSync(Pacer.Settings)({ ...settings, summaryWriter: "openforge" }).summaryWriter).toBe(
      "openforge",
    )
    // A service that can't tell leaves them out.
    expect(Schema.decodeUnknownSync(Pacer.Settings)({ compactColdFirst: true, compactBeforeCold: false })).toEqual({
      compactColdFirst: true,
      compactBeforeCold: false,
    })
    // CLIProxyPacer's own words for the writer are the service's to map.
    expect(() => Schema.decodeUnknownSync(Pacer.Settings)({ ...settings, summaryWriter: "server" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Settings)({ ...settings, keepUserMessages: "on" })).toThrow()
    expect(Schema.decodeUnknownSync(Pacer.SettingsUpdate)({ summaryWriter: "openforge" })).toEqual({
      summaryWriter: "openforge",
    })
    expect(Schema.decodeUnknownSync(Pacer.SettingsUpdate)({ keepUserMessages: false })).toEqual({
      keepUserMessages: false,
    })
    expect(() => Schema.decodeUnknownSync(Pacer.SettingsUpdate)({ summaryWriter: "client" })).toThrow()
  })

  test("events carry the shapes", () => {
    expect(Pacer.Event.ChatUpdated.data.make({ chat })).toEqual({ chat })
    expect(Pacer.Event.RequestsUpdated.data.make({ sessionID })).toEqual({ sessionID })
    expect(Pacer.Event.RequestsUpdated.data.make({})).toEqual({})
    const status: Pacer.Status = { state: "unreachable", since: 1, asOf: 0, message: "timed out", refused: false }
    expect(Pacer.Event.StatusChanged.data.make({ status })).toEqual({ status })
  })

  test("a cache notice encodes without its absent fields and decodes back; its event carries it", () => {
    // Spec cliproxypacer-cache-notices, section 2.
    const notice: Pacer.Notice = {
      requestID: "req-1",
      sessionID,
      rootID: SessionID.make("ses_pacer_root"),
      title: "a chat",
      agent: Agent.ID.make("explore"),
      model: "model-a",
      verdict: "partial",
      tokens: 18_000,
      cause: "prefix · tools",
      missCost: Money.USD.make(0.12),
      at: 980_000,
    }
    expect(
      Schema.decodeUnknownSync(Pacer.Notice)(JSON.parse(JSON.stringify(Schema.encodeSync(Pacer.Notice)(notice)))),
    ).toEqual(notice)
    const bare: Pacer.Notice = {
      requestID: "req-2",
      sessionID,
      rootID: sessionID,
      model: "model-a",
      verdict: "miss",
      cause: "unknown cause",
      at: 1,
    }
    expect(Object.keys(Schema.encodeSync(Pacer.Notice)(bare)).toSorted()).toEqual([
      "at",
      "cause",
      "model",
      "requestID",
      "rootID",
      "sessionID",
      "verdict",
    ])
    expect(() => Schema.decodeUnknownSync(Pacer.Notice)({ ...bare, verdict: "hit" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Notice)({ ...bare, tokens: -1 })).toThrow()
    expect(Pacer.Event.NoticeAdded.data.make({ notice })).toEqual({ notice })
    expect(Pacer.Event.NoticeDismissed.data.make({ requestID: "req-1" })).toEqual({ requestID: "req-1" })
  })

  test("a request says who changed its prompt and which older copy the provider read; both absent when unknown", () => {
    const copied: Pacer.Request = {
      ...request,
      cause: "provider",
      changedBy: "openforge",
      copy: { id: "req-0", at: 970_000 },
    }
    expect(Schema.decodeUnknownSync(Pacer.Request)(JSON.parse(JSON.stringify(copied)))).toEqual(copied)
    expect(Schema.encodeSync(Pacer.Request)(request)).not.toHaveProperty("copy")
    expect(Schema.encodeSync(Pacer.Request)(request)).not.toHaveProperty("changedBy")
    expect(() => Schema.decodeUnknownSync(Pacer.Request)({ ...request, changedBy: "client" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Pacer.Request)({ ...request, copy: { id: "req-0" } })).toThrow()
  })
})

describe("a miss's cause in words", () => {
  const words = (cause: string | undefined, extra: Omit<Parameters<typeof Pacer.causeWords>[0], "cause"> = {}) =>
    Pacer.causeWords({ cause, ...extra })

  test("each cause CLIProxyPacer gives, short and in a sentence", () => {
    expect(words("expired")).toEqual({ short: "cache expired", full: "The chat was idle longer than its cache lasts." })
    expect(words("compaction")).toEqual({
      short: "chat compacted",
      full: "The chat was compacted: a summary replaced its history.",
    })
    expect(words("summary-request")).toEqual({
      short: "summary mismatch",
      full: "CLIProxyPacer's summary request didn't match the cache.",
    })
    expect(words("account-changed")).toEqual({
      short: "another account",
      full: "It went to another account, which had no cache of this chat.",
    })
    expect(words("model-changed")).toEqual({
      short: "model switched",
      full: "Another model ran in between; each model has its own cache.",
    })
    expect(words("lifetime-changed", { changedPart: "system[0]" })).toEqual({
      short: "longer cache time",
      full: "The cache was set to last longer: it was all written again.",
    })
    expect(words("prefix-changed", { changedPart: "system[1]" })).toEqual({
      short: "new system prompt",
      full: "The system prompt changed since the step before.",
    })
    expect(words("server-layout", { changedPart: "messages[1]" })).toEqual({
      short: "proxy's layout",
      full: "CLIProxyPacer's layout of message 2 broke the cache.",
    })
    expect(words("server-layout")).toEqual({
      short: "proxy's layout",
      full: "CLIProxyPacer's layout of the prompt broke the cache.",
    })
    expect(words("provider")).toEqual({
      short: "provider's fault",
      full: "Nothing sent changed; the provider didn't reuse its cache.",
    })
    expect(words("unknown")).toEqual({
      short: "cause unknown",
      full: "CLIProxyPacer couldn't tell why: one prompt wasn't kept.",
    })
  })

  test("a provider's miss names the older copy it read by that request's time", () => {
    const at = new Date(2026, 10, 19, 14, 2, 11).getTime()
    expect(words("provider", { copy: { id: "req-0", at } })).toEqual({
      short: "provider's old copy",
      full: "The provider read an older copy of the chat, from 14:02:11.",
    })
    // Only a provider's miss reads a copy.
    expect(words("expired", { copy: { id: "req-0", at } }).short).toBe("cache expired")
  })

  test("a changed prompt names the part, a message counted from 1, and who changed it when CLIProxyPacer could tell", () => {
    const short = (changedPart: string | undefined) => words("prefix-changed", { changedPart }).short
    const full = (changedPart: string | undefined, changedBy?: "openforge" | "cliproxypacer") =>
      words("prefix-changed", { changedPart, changedBy }).full
    expect(short("system")).toBe("new system prompt")
    expect(short("instructions")).toBe("new system prompt")
    expect(short("request.systemInstruction")).toBe("new system prompt")
    expect(short("tools")).toBe("new tool list")
    expect(short("tools[3]")).toBe("new tool list")
    expect(short("messages[3]")).toBe("message 4 changed")
    expect(short("input[0]")).toBe("message 1 changed")
    expect(short("request.contents[11]")).toBe("message 12 changed")
    expect(short("messages")).toBe("messages changed")
    expect(short("model")).toBe("model name changed")
    expect(short("prompt_cache_key")).toBe("new cache key")
    expect(short("reasoning")).toBe("thinking changed")
    expect(short("temperature")).toBe("setting changed")
    expect(short(undefined)).toBe("prompt changed")
    expect(full("messages[3]")).toBe("Message 4 of the prompt changed since the step before.")
    expect(full("temperature")).toBe("The setting temperature changed since the step before.")
    expect(full(undefined)).toBe("The prompt changed since the step before.")
    expect(full("messages[3]", "openforge")).toBe("openforge changed message 4 of the prompt.")
    expect(full("tools[2]", "openforge")).toBe("openforge changed the tool list.")
    expect(full("system[0]", "cliproxypacer")).toBe("CLIProxyPacer's redaction changed the system prompt.")
    // Who changed it says nothing for another cause.
    expect(words("provider", { changedBy: "openforge" }).full).toBe(words("provider").full)
  })

  test("no cause, and a cause openforge doesn't know, which shows as CLIProxyPacer sent it", () => {
    expect(words(undefined)).toEqual({ short: "cause unknown", full: "CLIProxyPacer didn't say why." })
    expect(words("")).toEqual(words(undefined))
    // A part without a cause is a part that changed.
    expect(words(undefined, { changedPart: "tools[0]" })).toEqual(words("prefix-changed", { changedPart: "tools[0]" }))
    expect(words("cache-evicted")).toEqual({
      short: "cache-evicted",
      full: "CLIProxyPacer gave the cause cache-evicted.",
    })
    expect(words("cache-evicted", { changedPart: "messages[2]" })).toEqual({
      short: "cache-evicted · messages[2]",
      full: "CLIProxyPacer gave the cause cache-evicted, at messages[2].",
    })
    expect(words("constructor").short).toBe("constructor")
  })

  test("the short words fit the verdict column after `partial: `, the sentence a cache notice's card", () => {
    const at = new Date(2026, 10, 19, 23, 59, 59).getTime()
    const cases = [
      ...["expired", "compaction", "summary-request", "account-changed", "model-changed", "lifetime-changed"].map(
        (cause) => words(cause),
      ),
      ...["unknown", "provider", undefined].map((cause) => words(cause)),
      words("provider", { copy: { id: "req-0", at } }),
      words("server-layout", { changedPart: "messages[998]" }),
      ...["system[12]", "tools[40]", "messages[998]", "prompt_cache_key", "temperature", "messages", undefined].flatMap(
        (changedPart) =>
          [undefined, "openforge" as const, "cliproxypacer" as const].map((changedBy) =>
            words("prefix-changed", { changedPart, changedBy }),
          ),
      ),
      // Antigravity's settings, which CLIProxyPacer's secret hiding never changes.
      ...[undefined, "openforge" as const].map((changedBy) =>
        words("prefix-changed", { changedPart: "request.generationConfig", changedBy }),
      ),
    ]
    for (const said of cases) {
      expect(`partial: ${said.short}`.length).toBeLessThanOrEqual(28)
      expect(said.full.length).toBeLessThanOrEqual(60)
    }
  })
})
