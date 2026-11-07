import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../src/session-message.js"

// Spec cliproxypacer-server-summaries, section 3, "The record": a completed compaction of a chat on CLIProxyPacer
// says who wrote its summary.

const completed = {
  id: "msg_compaction",
  type: "compaction",
  status: "completed",
  reason: "auto",
  summary: "What happened so far.",
  time: { created: 1_000 },
} as const

const decode = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)
const encode = Schema.encodeSync(SessionMessage.CompactionCompleted)

describe("a completed compaction's writer", () => {
  test("CLIProxyPacer wrote it, cold, keeping 12 of your messages: decodes and encodes back", () => {
    const message = decode({ ...completed, writer: { by: "cliproxypacer", cold: true, userMessages: 12 } })
    expect(message.writer).toEqual({ by: "cliproxypacer", cold: true, userMessages: 12 })
    expect(decode(encode(message))).toEqual(message)
  })

  test("openforge wrote it after CLIProxyPacer couldn't, or by choice", () => {
    expect(decode({ ...completed, writer: { by: "openforge", fallback: "501" } }).writer).toEqual({
      by: "openforge",
      fallback: "501",
    })
    expect(decode({ ...completed, writer: { by: "openforge" } }).writer).toEqual({ by: "openforge" })
  })

  test("a compaction without one decodes as before", () => {
    const message = decode(completed)
    expect(message.writer).toBeUndefined()
    expect("writer" in encode(message)).toBe(false)
  })

  test("rejects values outside the shape", () => {
    expect(() => decode({ ...completed, writer: { by: "server" } })).toThrow()
    expect(() => decode({ ...completed, writer: {} })).toThrow()
    expect(() => decode({ ...completed, writer: { by: "cliproxypacer", userMessages: -1 } })).toThrow()
    expect(() => decode({ ...completed, writer: { by: "cliproxypacer", userMessages: 1.5 } })).toThrow()
    expect(() => decode({ ...completed, writer: { by: "cliproxypacer", cold: "yes" } })).toThrow()
  })
})
