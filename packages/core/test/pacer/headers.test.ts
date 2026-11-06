import { describe, expect, test } from "bun:test"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHeaders } from "@opencode/core/pacer/headers"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { SessionID } from "@opencode/schema/session-id"

const sessionID = SessionID.make("ses_headers_child")
const parentID = SessionID.make("ses_headers_parent")
const chat = PacerSessionID.make(sessionID)
const parent = PacerSessionID.make(parentID)

describe("PacerHeaders", () => {
  test("marks a step with the chat and the compaction asks it acts on, and no kind", () => {
    expect(PacerHeaders.make({ providerID: PacerEndpoint.id, kind: "primary", sessionID })).toEqual({
      "X-Pacer-Session": chat,
      "X-Pacer-Compact": "auto, before-cold",
    })
  })

  test("marks titles and one-off generations as title, summaries as compaction", () => {
    const kind = (kind: PacerHeaders.Input["kind"]) =>
      PacerHeaders.make({ providerID: PacerEndpoint.id, kind, sessionID })
    expect(kind("title")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "title" })
    expect(kind("generate")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "title" })
    expect(kind("compaction")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "compaction" })
  })

  test("names a subagent's parent on each of its requests", () => {
    for (const kind of ["primary", "title", "generate", "compaction"] as const)
      expect(PacerHeaders.make({ providerID: PacerEndpoint.id, kind, sessionID, parentID })).toMatchObject({
        "X-Pacer-Session": chat,
        "X-Pacer-Parent-Session": parent,
      })
  })

  test("adds nothing for another provider", () => {
    for (const providerID of ["anthropic", "openai", "cliproxyapi", "CLIProxyPacer"])
      expect(PacerHeaders.make({ providerID, kind: "primary", sessionID, parentID })).toEqual({})
  })
})
