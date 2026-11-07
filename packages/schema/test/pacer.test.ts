import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
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
      "pacer.chat.updated",
      "pacer.requests.updated",
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

  test("events carry the shapes", () => {
    expect(Pacer.Event.ChatUpdated.data.make({ chat })).toEqual({ chat })
    expect(Pacer.Event.RequestsUpdated.data.make({ sessionID })).toEqual({ sessionID })
    expect(Pacer.Event.RequestsUpdated.data.make({})).toEqual({})
    const status: Pacer.Status = { state: "unreachable", since: 1, asOf: 0, message: "timed out", refused: false }
    expect(Pacer.Event.StatusChanged.data.make({ status })).toEqual({ status })
  })
})
