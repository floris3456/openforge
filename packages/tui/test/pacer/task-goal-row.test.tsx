import { describe, expect, test } from "bun:test"
import type { JsonValue, SessionInfo, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { recordFrames } from "../fixture/frames"
import { directory, json } from "../fixture/tui-client"
import { until } from "../fixture/wait"

// The goals board (workspace reference `docs/reference/goals-board-api.md`, "The task tool"): a call of CLIProxyPacer's
// `task` tool that makes a goal shows as "Goal: <title>" in its row; every other task call keeps the row it had, the
// tool's name and its arguments, and none is drawn as a subagent. The whole app draws a chat whose step holds the calls,
// and every frame it draws is checked.

const SESSION = "ses_task_goal_rows"
const session = {
  id: SESSION,
  title: "Goals",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
} satisfies SessionInfo
const GOAL = "g4k2m8q1z7xa"
const TASK = "t8n2k4m7q9xz"

type Input = Record<string, JsonValue>

function call(id: string, input: Input, failed?: string): SessionMessageAssistantTool {
  return {
    type: "tool",
    id,
    name: "task",
    time: { created: 10, completed: 11 },
    state: failed
      ? { status: "error", input, metadata: {}, error: { type: "tool.execution", message: failed } }
      : { status: "completed", input, metadata: {}, content: [{ type: "text", text: "CPP's text" }] },
  }
}

function chat(parts: SessionMessageAssistantTool[]): SessionMessageInfo[] {
  return [
    { type: "user", id: "msg_user", text: "Plan the board", time: { created: 1 } },
    {
      type: "assistant",
      id: "msg_step",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      time: { created: 2, completed: 20 },
      finish: "stop",
      content: parts,
    },
  ]
}

async function transcript(messages: SessionMessageInfo[]) {
  const listening = Promise.withResolvers<void>()
  const setup = await createAppFixture({
    width: 120,
    height: 30,
    args: { sessionID: SESSION },
    config: { animations: false, session: { sidebar: "hide", grouping: "none" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${SESSION}`) return json({ data: session })
      if (url.pathname === `/api/session/${SESSION}/message`)
        return listening.promise.then(() => json({ data: messages.toReversed(), cursor: {} }))
      if (url.pathname === `/api/session/${SESSION}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${SESSION}/inbox`) return json({ data: [] })
    },
  })
  await setup.ready
  const recorder = recordFrames(setup)
  listening.resolve()
  return {
    ...setup,
    recorder,
    async [Symbol.asyncDispose]() {
      recorder.stop()
      await setup[Symbol.asyncDispose]()
    },
  }
}

/** The frame's tool rows: the lines that start with a generic row's icon. */
const rows = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[✓✗] /.test(line))

describe("task calls in the chat", () => {
  test("a call that makes a goal shows as the goal, the others as before, on every frame", async () => {
    const parts = [
      call("call_goal", { kind: "goal", title: "Task tool  improvements", description: "Done when leads see it" }),
      call("call_goal_untitled", { kind: "goal" }),
      call("call_goal_refused", { kind: "goal", title: "Not mine" }, "Only a lead makes goals."),
      call("call_task", { title: "Board UI", goal: GOAL }),
      call("call_move", { id: TASK, goal: GOAL }),
      call("call_state", { id: TASK, state: "active" }),
    ]
    const expected = [
      "✓ Goal: Task tool improvements",
      "✓ Goal",
      "✗ Goal: Not mine",
      `✓ task [title=Board UI, goal=${GOAL}]`,
      `✓ task [id=${TASK}, goal=${GOAL}]`,
      `✓ task [id=${TASK}, state=active]`,
    ]
    await using setup = await transcript(chat(parts))
    await until(() => rows(setup.captureCharFrame()).length === expected.length, 5_000).catch(() => {
      throw new Error(`no frame showed the rows within 5 s:\n${setup.captureCharFrame()}`)
    })
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(rows(setup.captureCharFrame())).toEqual(expected)
    expect(setup.captureCharFrame()).not.toContain("Subagent")
    expect(setup.recorder.missed).toBe(0)
    const drawn = setup.recorder.frames.map((frame) => rows(frame.text)).filter((shown) => shown.length > 0)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.filter((shown) => shown.join("\n") !== expected.join("\n"))).toEqual([])
  })
})
