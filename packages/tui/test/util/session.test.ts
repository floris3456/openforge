import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { contextUsage, formatContextUsage, sessionFamily } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  // Spec compaction-threshold-per-client, section 3: a chat at the point shows 100%.
  test("counts the context against the model's compaction point when it has one, else its window", () => {
    const step = (input: number): SessionMessageInfo => ({
      id: "msg_step",
      type: "assistant",
      agent: "build",
      model: { id: "claude-test", providerID: "cliproxypacer" },
      content: [],
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    })
    const model = (limit: ModelInfo["limit"]): ModelInfo => ({
      id: "claude-test",
      modelID: "claude-test",
      providerID: "cliproxypacer",
      name: "Claude Test",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit,
    })
    const pointed = [model({ context: 1_000_000, output: 64_000, compact: 500_000 })]
    const at = contextUsage([step(500_000)], pointed)
    expect(at).toEqual({ tokens: 500_000, percent: 100 })
    expect(formatContextUsage(500_000, at?.percent)).toBe("500.0K (100%)")
    expect(contextUsage([step(250_000)], pointed)).toEqual({ tokens: 250_000, percent: 50 })
    // Without a point, as before: the model's context window.
    expect(contextUsage([step(500_000)], [model({ context: 1_000_000, output: 64_000 })])).toEqual({
      tokens: 500_000,
      percent: 50,
    })
    expect(contextUsage([step(500_000)], [model({ context: 0, output: 0 })])).toEqual({
      tokens: 500_000,
      percent: undefined,
    })
  })
})
