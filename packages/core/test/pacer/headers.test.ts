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
    expect(PacerHeaders.make({ providerID: PacerEndpoint.id, kind: "primary", sessionID, auto: true })).toEqual({
      "X-Pacer-Session": chat,
      "X-Pacer-Compact": "auto, cold, before-cold",
    })
  })

  test("leaves auto and cold out of a step's asks while the chat does not compact automatically", () => {
    expect(PacerHeaders.make({ providerID: PacerEndpoint.id, kind: "primary", sessionID, auto: false })).toEqual({
      "X-Pacer-Session": chat,
      "X-Pacer-Compact": "before-cold",
    })
  })

  test("marks titles and one-off generations as title, summaries as compaction", () => {
    for (const auto of [true, false]) {
      const kind = (kind: PacerHeaders.Input["kind"]) =>
        PacerHeaders.make({ providerID: PacerEndpoint.id, kind, sessionID, auto })
      expect(kind("title")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "title" })
      expect(kind("generate")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "title" })
      expect(kind("compaction")).toEqual({ "X-Pacer-Session": chat, "X-Pacer-Kind": "compaction" })
    }
  })

  test("names a subagent's parent on each of its requests", () => {
    for (const kind of ["primary", "title", "generate", "compaction"] as const)
      expect(PacerHeaders.make({ providerID: PacerEndpoint.id, kind, sessionID, parentID, auto: true })).toMatchObject({
        "X-Pacer-Session": chat,
        "X-Pacer-Parent-Session": parent,
      })
  })

  test("names a tool list read's or tool call's chat, and a subagent's parent, whatever the chat's provider", () => {
    expect(PacerHeaders.chat({ sessionID })).toEqual({ "X-Pacer-Session": chat })
    expect(PacerHeaders.chat({ sessionID, parentID })).toEqual({
      "X-Pacer-Session": chat,
      "X-Pacer-Parent-Session": parent,
    })
  })

  test("adds nothing for another provider, its project's headers neither", () => {
    const project = PacerHeaders.project(identity, { name: "openforge" })
    for (const providerID of ["anthropic", "openai", "cliproxyapi", "CLIProxyPacer"])
      expect(PacerHeaders.make({ providerID, kind: "primary", sessionID, parentID, auto: true, project })).toEqual({})
  })

  test("names the chat's project beside the chat on each kind of request, and on tool list reads and calls", () => {
    const project = PacerHeaders.project(identity, { name: "github.com/owner/repo", remote: "github.com/owner/repo" })
    const named = {
      "X-Pacer-Project": identity,
      "X-Pacer-Project-Name": "github.com%2Fowner%2Frepo",
      "X-Pacer-Project-Remote": "github.com%2Fowner%2Frepo",
    }
    for (const kind of ["primary", "title", "generate", "compaction"] as const)
      expect(
        PacerHeaders.make({ providerID: PacerEndpoint.id, kind, sessionID, parentID, auto: true, project }),
      ).toMatchObject({
        "X-Pacer-Session": chat,
        "X-Pacer-Parent-Session": parent,
        ...named,
      })
    expect(PacerHeaders.chat({ sessionID, project })).toEqual({ "X-Pacer-Session": chat, ...named })
  })
})

const identity = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

describe("PacerHeaders.project", () => {
  test("percent-encodes the name and the remote as UTF-8, a non-ASCII folder name included", () => {
    expect(PacerHeaders.project(identity, { name: "Café ü 東京 🚀" })).toEqual({
      "X-Pacer-Project": identity,
      "X-Pacer-Project-Name": "Caf%C3%A9%20%C3%BC%20%E6%9D%B1%E4%BA%AC%20%F0%9F%9A%80",
    })
    expect(
      decodeURIComponent(PacerHeaders.project(identity, { name: "Café ü 東京 🚀" })["X-Pacer-Project-Name"]!),
    ).toBe("Café ü 東京 🚀")
    expect(
      PacerHeaders.project(identity, { name: "gitlab.com/group/sub group", remote: "gitlab.com/group/sub group" }),
    ).toEqual({
      "X-Pacer-Project": identity,
      "X-Pacer-Project-Name": "gitlab.com%2Fgroup%2Fsub%20group",
      "X-Pacer-Project-Remote": "gitlab.com%2Fgroup%2Fsub%20group",
    })
  })

  test("keeps at most 200 characters of the name, counted decoded, a character outside the BMP as one", () => {
    const name = PacerHeaders.project(identity, { name: "🚀".repeat(250) })["X-Pacer-Project-Name"]!
    expect([...decodeURIComponent(name)]).toHaveLength(200)
    expect(decodeURIComponent(PacerHeaders.project(identity, { name: "a".repeat(200) })["X-Pacer-Project-Name"]!)).toBe(
      "a".repeat(200),
    )
  })

  test("names no project for an identity outside memory's rule", () => {
    for (const bad of ["", "has space", "slash/inside", "café", "p".repeat(129)])
      expect(PacerHeaders.project(bad, { name: "openforge", remote: "github.com/owner/repo" })).toEqual({})
    expect(PacerHeaders.project("p".repeat(128), { name: "x" })["X-Pacer-Project"]).toBe("p".repeat(128))
  })
})
