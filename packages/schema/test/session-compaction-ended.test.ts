import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event.js"

// Spec cliproxypacer-server-summaries, section 3, "The record": the compaction's ended event carries who wrote the
// summary to the record (the session's message updater) and to clients that build the message from events.

const decode = Schema.decodeUnknownSync(SessionEvent.Compaction.Ended.data)
const encode = Schema.encodeSync(SessionEvent.Compaction.Ended.data)
const ended = {
  sessionID: "ses_compaction_ended",
  reason: "auto",
  model: { providerID: "cliproxypacer", id: "claude-haiku-5-5" },
  text: "What happened so far.",
} as const

test("the ended event says who wrote the summary, and round trips", () => {
  const writer = { by: "cliproxypacer", cold: true, userMessages: 3 } as const
  const data = decode({ ...ended, writer })
  expect(data.writer).toEqual(writer)
  expect(encode(data)).toEqual({ ...ended, writer })
  expect(decode({ ...ended, writer: { by: "openforge", fallback: "it answered 501" } }).writer).toEqual({
    by: "openforge",
    fallback: "it answered 501",
  })
})

test("an ended event without a writer decodes as before; one outside the shape is refused", () => {
  expect(decode(ended).writer).toBeUndefined()
  expect("writer" in encode(decode(ended))).toBe(false)
  expect(() => decode({ ...ended, writer: { by: "server" } })).toThrow()
})
