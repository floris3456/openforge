import { describe, expect, test } from "bun:test"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"

// Spec checkpoint, section 5: below a compaction's summary, CLIProxyPacer's list of the person's earlier messages shows
// under "Your earlier messages", one message per line as `n. text` and a gap as `n–m: see the summary`, without its
// tags or escapes.

const session = {
  id: "ses_earlier",
  title: "Earlier messages",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "cliproxypacer", id: "claude-haiku-5-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const summary = [
  "Summary of the work.",
  "",
  "<earlier-user-messages>",
  '<message n="1">fix the &lt;/message> tag\nin the parser</message>',
  '<gap from="2" to="23">see the summary</gap>',
  '<message n="24">ship it [pasted, 40 lines]</message>',
  "</earlier-user-messages>",
].join("\n")
const messages = [
  {
    id: "msg_c1",
    type: "compaction",
    time: { created: 1 },
    status: "completed",
    reason: "auto",
    summary,
    model: { providerID: "cliproxypacer", id: "gemini-3.8-flash-high" },
    writer: { by: "cliproxypacer", userMessages: 2 },
  },
]

describe("the list of earlier messages below a summary", () => {
  test("one line per message and gap, without tags or escapes", async () => {
    const state = await tmpdir()
    await using _state = state
    const setup = await createAppFixture({
      width: 120,
      height: 40,
      state: state.path,
      config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
      args: { sessionID: session.id },
      fetch: (url) => {
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
        if (
          url.pathname === `/api/session/${session.id}/inbox` ||
          url.pathname === `/api/session/${session.id}/permission`
        )
          return json({ data: [] })
        return undefined
      },
    })
    await using _ = setup
    const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("Your earlier messages"), {
      maxPasses: 200,
    })
    const lines = frame.split("\n").map((line) => line.trim())
    const start = lines.indexOf("Your earlier messages")
    expect(lines.slice(start, start + 4)).toEqual([
      "Your earlier messages",
      "1. fix the </message> tag in the parser",
      "2–23: see the summary",
      "24. ship it [pasted, 40 lines]",
    ])
    expect(lines.indexOf("Summary of the work.")).toBeLessThan(start)
    expect(frame).not.toContain("<message")
    expect(frame).not.toContain("earlier-user-messages")
    expect(frame).not.toContain("&lt;")
  })
})
