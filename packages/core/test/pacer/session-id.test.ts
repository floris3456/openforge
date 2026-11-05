import { describe, expect, test } from "bun:test"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { SessionID } from "@opencode/schema/session-id"

// Computed independently with Python's uuid.uuid5(UUID("25d56e25-f22e-4ada-ad98-ba61ea70f729"), name).
const vectors = [
  ["ses_0123456789abcdefABCDEFGHIJ", "23b3458a-ae85-5082-a76b-938d81a9d86f"],
  ["ses_7f3a9c21e5ffe1Qx2Lr8NnKpWd", "9119a16a-91f5-504c-b39a-943bae0c762f"],
  ["ses_", "6e56f755-e9dc-558a-8f00-eeb8764ef66b"],
  ["ses_ü", "61c270a0-382d-57d7-bc06-901c9ee2fbcd"],
] as const

describe("PacerSessionID", () => {
  test("is the UUID v5 of the session ID under openforge's namespace", () => {
    expect(PacerSessionID.namespace).toBe("25d56e25-f22e-4ada-ad98-ba61ea70f729")
    for (const [sessionID, uuid] of vectors) expect(PacerSessionID.make(SessionID.make(sessionID))).toBe(uuid)
  })

  test("matches Bun's own UUID v5 for generated session IDs", () => {
    for (const sessionID of Array.from({ length: 20 }, () => SessionID.create()))
      expect(PacerSessionID.make(sessionID)).toBe(Bun.randomUUIDv5(sessionID, PacerSessionID.namespace))
  })

  test("is lowercase, version 5 and RFC 4122 variant, and stable", () => {
    const sessionID = SessionID.create()
    const uuid = PacerSessionID.make(sessionID)
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(PacerSessionID.make(sessionID)).toBe(uuid)
  })
})
