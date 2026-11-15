import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "../src/promise"
import { contextLimit, lastAssistantWithUsage } from "../src/solid/usage"

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

describe("lastAssistantWithUsage", () => {
  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      time: { created: 0 },
    }

    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })
})

describe("contextLimit", () => {
  test("is the model's compaction point when it has one, so a chat at the point is at 100%", () => {
    expect(contextLimit({ context: 1_000_000, compact: 500_000 })).toBe(500_000)
  })

  test("is the context window without a point, and undefined while neither is known", () => {
    expect(contextLimit({ context: 200_000 })).toBe(200_000)
    expect(contextLimit({ context: 0 })).toBeUndefined()
    expect(contextLimit(undefined)).toBeUndefined()
  })
})
