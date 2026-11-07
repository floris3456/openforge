import { describe, expect, test } from "bun:test"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { tmpdir } from "../fixture/fixture"
import { directory, json } from "../fixture/tui-client"
import { compactionLine } from "../../src/pacer/format"

// Spec cliproxypacer-server-summaries, section 3, "On screen" and "The record": the compaction's divider names who
// wrote the summary, each part only when known, on one line. A narrow window drops the optional parts in this order:
// the usage, the count of your messages kept, the model, `cold`; a fallback's reason is cut before it goes; the head
// is cut last.

const FULL =
  "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · cold · 12 of your messages kept · 20.2K in · 214 out"
const cpp = {
  writer: { by: "cliproxypacer" as const, cold: true, userMessages: 12 },
  model: "gemini-3.8-flash-high",
  usage: "20.2K in · 214 out",
}

describe("the divider's line", () => {
  test("CLIProxyPacer wrote it: who, on which model, cold, your messages kept, and the usage", () => {
    expect(compactionLine(cpp, 200)).toBe(FULL)
  })

  test("each part only when known", () => {
    expect(compactionLine({ writer: { by: "cliproxypacer" } }, 200)).toBe("Compaction · by CLIProxyPacer")
    expect(compactionLine({ ...cpp, model: undefined }, 200)).toBe(
      "Compaction · by CLIProxyPacer · cold · 12 of your messages kept · 20.2K in · 214 out",
    )
    // Warm says nothing: only `cold` is a part.
    expect(compactionLine({ ...cpp, writer: { by: "cliproxypacer", cold: false, userMessages: 12 } }, 200)).toBe(
      "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · 12 of your messages kept · 20.2K in · 214 out",
    )
    expect(compactionLine({ ...cpp, writer: { by: "cliproxypacer", cold: true } }, 200)).toBe(
      "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · cold · 20.2K in · 214 out",
    )
    // None kept is still a count.
    expect(compactionLine({ writer: { by: "cliproxypacer", userMessages: 0 } }, 200)).toBe(
      "Compaction · by CLIProxyPacer · 0 of your messages kept",
    )
  })

  test("openforge wrote it after CLIProxyPacer couldn't, or by choice", () => {
    expect(compactionLine({ writer: { by: "openforge", fallback: "501 remote_compaction_unsupported" } }, 200)).toBe(
      "Compaction · by openforge · CLIProxyPacer couldn't: 501 remote_compaction_unsupported",
    )
    expect(compactionLine({ writer: { by: "openforge" } }, 200)).toBe("Compaction · by openforge")
    // Its usage, as every compaction's, and the reason on one line.
    expect(
      compactionLine(
        { writer: { by: "openforge", fallback: "no answer\n  within 4 minutes" }, usage: "12.0K in · 300 out" },
        200,
      ),
    ).toBe("Compaction · by openforge · CLIProxyPacer couldn't: no answer within 4 minutes · 12.0K in · 300 out")
  })

  test("a narrow window drops the usage, then your messages kept, then the model, then cold; the head is cut last", () => {
    const steps = [
      FULL,
      "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · cold · 12 of your messages kept",
      "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · cold",
      "Compaction · by CLIProxyPacer · cold",
      "Compaction · by CLIProxyPacer",
    ]
    steps.forEach((line, index) => {
      // At its own width, and down to one cell more than the next shorter line.
      expect(compactionLine(cpp, line.length)).toBe(line)
      if (index + 1 < steps.length) expect(compactionLine(cpp, steps[index + 1]!.length + 1)).toBe(steps[index + 1]!)
    })
    expect(compactionLine(cpp, 20)).toBe("Compaction · by CLI…")
    expect(compactionLine(cpp, 0)).toBe("")
  })

  test("a narrow window drops openforge's usage first, then cuts CLIProxyPacer's reason, then drops it", () => {
    const fallback = { by: "openforge" as const, fallback: "no readable summary in the answer" }
    const full = "Compaction · by openforge · CLIProxyPacer couldn't: no readable summary in the answer"
    expect(compactionLine({ writer: fallback, usage: "12.0K in · 300 out" }, full.length + 21)).toBe(
      `${full} · 12.0K in · 300 out`,
    )
    expect(compactionLine({ writer: fallback, usage: "12.0K in · 300 out" }, full.length)).toBe(full)
    expect(compactionLine({ writer: fallback }, 60)).toBe(
      "Compaction · by openforge · CLIProxyPacer couldn't: no read…",
    )
    // While at least one character of the reason fits, with its "…".
    expect(compactionLine({ writer: fallback }, 54)).toBe("Compaction · by openforge · CLIProxyPacer couldn't: n…")
    expect(compactionLine({ writer: fallback }, 53)).toBe("Compaction · by openforge")
  })
})

// The whole TUI, a chat holding three compactions: CLIProxyPacer's, openforge's after a fallback, and one without a
// writer, which shows as before the writer existed.
const session = {
  id: "ses_summaries",
  title: "Summaries",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "cliproxypacer", id: "claude-haiku-5-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})
const compaction = (id: string, created: number, summary: string, extra: Record<string, unknown>) => ({
  id,
  type: "compaction",
  time: { created },
  status: "completed",
  reason: "auto",
  summary,
  ...extra,
})
const messages = [
  compaction("msg_c1", 1, "Summary one.", {
    model: { providerID: "cliproxypacer", id: "gemini-3.8-flash-high" },
    writer: { by: "cliproxypacer", cold: true, userMessages: 12 },
    tokens: tokens(20_182, 214),
  }),
  compaction("msg_c2", 2, "Summary two.", {
    model: { providerID: "cliproxypacer", id: "claude-haiku-5-5" },
    writer: { by: "openforge", fallback: "501 remote_compaction_unsupported" },
  }),
  compaction("msg_c3", 3, "Summary three.", { tokens: tokens(1_200, 300) }),
]

async function chat(width: number) {
  const state = await tmpdir()
  const setup = await createAppFixture({
    width,
    height: 40,
    state: state.path,
    config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages.toReversed(), cursor: {} })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })
  return { setup, state }
}

/** The divider lines of a frame, without their rules, in the transcript's order. */
const dividers = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => line.includes("Compaction"))
    .map((line) => line.replace(/[─]+/g, "").trim())

describe("the divider in the chat", () => {
  test("wide: each writer's whole line, and one without a writer as before", async () => {
    const { setup, state } = await chat(160)
    await using _state = state
    await using _ = setup
    const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("Summary three."), { maxPasses: 200 })
    expect(dividers(frame)).toEqual([
      FULL,
      "Compaction · by openforge · CLIProxyPacer couldn't: 501 remote_compaction_unsupported",
      "Compaction · 1.2K in · 300 out",
    ])
  })

  test("narrow: still one line each, the optional parts dropped in order", async () => {
    const { setup, state } = await chat(80)
    await using _state = state
    await using _ = setup
    const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("Summary three."), { maxPasses: 200 })
    // The transcript is 76 cells wide here: the line gets 70, with two cells of rule on each side.
    expect(dividers(frame)).toEqual([
      "Compaction · by CLIProxyPacer on gemini-3.8-flash-high · cold",
      "Compaction · by openforge · CLIProxyPacer couldn't: 501 remote_compac…",
      "Compaction · 1.2K in · 300 out",
    ])
    const lines = frame.split("\n")
    lines.forEach((line, index) => {
      if (!line.includes("Compaction")) return
      expect(line).toMatch(/^\s*─{2,} Compaction.* ─{2,}\s*$/)
      // Nothing of it wraps onto the next line.
      expect(lines[index + 1]!.trim()).toBe("")
    })
  })
})
