import { describe, expect, test } from "bun:test"
import type { JsonValue } from "@opencode/client"
import { normalizeTool, toolInlineInfo, toolOutputText, toolPath, toolScroll } from "../../src/mini/tool"
import { canonicalToolPart } from "./fixture/tool-part"

describe("Mini tool presentation", () => {
  test("uses V2 shell output without the model-facing status", () => {
    expect(
      toolOutputText("shell", [
        { type: "text", text: "mini-output\n" },
        { type: "text", text: "Command exited with code 0." },
      ]),
    ).toBe("mini-output\n")

    expect(
      toolOutputText("shell", [
        { type: "text", text: "" },
        { type: "text", text: "Command exited with code 0." },
      ]),
    ).toBe("")
  })

  test("normalizes only persisted tool aliases into current fields", () => {
    expect(
      normalizeTool({
        type: "tool",
        id: "call-patch",
        name: "apply_patch",
        state: {
          status: "completed",
          input: { patchText: "*** Begin Patch\n*** End Patch" },
          metadata: {
            files: [
              {
                type: "update",
                filePath: "/tmp/project/src/a.ts",
                relativePath: "src/a.ts",
                patch: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
          },
          content: [{ type: "text", text: "patched" }],
        },
        time: { created: 1, ran: 1, completed: 2 },
      }),
    ).toMatchObject({
      name: "patch",
      state: {
        metadata: {
          files: [
            {
              status: "modified",
              file: "src/a.ts",
              patch: "@@ -1 +1 @@\n-old\n+new",
            },
          ],
        },
        content: [{ type: "text", text: "patched" }],
      },
    })

    expect(
      normalizeTool({
        type: "tool",
        id: "call-subagent",
        name: "subagent",
        state: {
          status: "running",
          input: { subagent_type: "explore", description: "Inspect" },
          metadata: {},
        },
        time: { created: 1, ran: 1 },
      }),
    ).toMatchObject({ name: "subagent", state: { input: { agent: "explore" } } })
  })

  // `task` is CLIProxyPacer's task-list tool: a call of it is never drawn as a subagent.
  test("keeps a task-list call a task", () => {
    const tool = normalizeTool({
      type: "tool",
      id: "call-task",
      name: "task",
      state: {
        status: "completed",
        input: { id: "kyk5w018z544", state: "active" },
        metadata: {},
        content: [{ type: "text", text: "Task kyk5w018z544 is active." }],
      },
      time: { created: 1, ran: 1, completed: 2 },
    })
    expect(tool.name).toBe("task")
    expect(tool.state.input).toEqual({ id: "kyk5w018z544", state: "active" })
  })

  // The goals board: a task call that makes a goal shows as the goal; the other task calls keep their rows.
  test("shows a task call that makes a goal as the goal", () => {
    const task = (input: Record<string, JsonValue>, metadata: Record<string, JsonValue> = {}) =>
      canonicalToolPart(
        "task",
        { status: "completed", input, metadata, content: [{ type: "text", text: "" }] },
        "call-task",
      )
    const frame = (input: Record<string, JsonValue>, meta: Record<string, JsonValue> = {}) => ({
      directory: "/work/project",
      raw: "",
      name: "task",
      input,
      meta,
      state: {},
      status: "running",
      error: "",
      output: "",
      time: {},
    })
    const goal = { kind: "goal", title: "Task tool improvements" }
    expect(toolInlineInfo(task(goal))).toEqual({ icon: "⚙", title: "Goal: Task tool improvements" })
    expect(toolScroll("start", frame(goal))).toBe("⚙ Goal: Task tool improvements")
    // The later items: a task turned into a goal, and a found task.
    const promoted = { id: "t8n2k4m7q9xz", kind: "goal" }
    expect(toolInlineInfo(task(promoted, { title: "Board UI" }))).toEqual({
      icon: "⚙",
      title: "Goal from task: Board UI",
    })
    expect(toolInlineInfo(task(promoted)).title).toBe("Goal from task: t8n2k4m7q9xz")
    expect(toolScroll("start", frame(promoted, { title: "Board UI" }))).toBe("⚙ Goal from task: Board UI")
    const found = { title: "Flaky test", found: true }
    expect(toolInlineInfo(task(found))).toEqual({ icon: "⚙", title: "Found: Flaky test" })
    expect(toolScroll("start", frame(found))).toBe("⚙ Found: Flaky test")
    const move = { id: "t8n2k4m7q9xz", goal: "g4k2m8q1z7xa" }
    expect(toolInlineInfo(task(move)).title).toBe(`task ${JSON.stringify(move)}`)
    expect(toolScroll("start", frame(move))).toBe("⚙ task [id=t8n2k4m7q9xz, goal=g4k2m8q1z7xa]")
  })

  test("renders the skill name from tool metadata with the input id as fallback", () => {
    const skill = (metadata: { name?: string }) =>
      canonicalToolPart(
        "skill",
        {
          status: "completed",
          input: { id: "tigerstyle" },
          metadata,
          content: [{ type: "text", text: "" }],
        },
        "call-skill",
      )

    expect(toolInlineInfo(skill({ name: "effect" })).title).toBe('Skill "effect"')
    expect(toolInlineInfo(skill({})).title).toBe('Skill "tigerstyle"')
    expect(
      toolScroll("start", {
        directory: "/work/project",
        raw: "",
        name: "skill",
        input: { id: "tigerstyle" },
        meta: { name: "effect" },
        state: {},
        status: "completed",
        error: "",
        output: "",
        time: {},
      }),
    ).toBe('→ Skill "effect"')
  })

  test("renders compact search metadata", () => {
    expect(
      toolInlineInfo(
        canonicalToolPart("glob", {
          status: "completed",
          input: { pattern: "*.ts" },
          metadata: { count: 3 },
          content: [{ type: "text", text: "" }],
        }),
      ).description,
    ).toBe("3 matches")
    expect(
      toolInlineInfo(
        canonicalToolPart("grep", {
          status: "completed",
          input: { pattern: "needle" },
          metadata: { matches: 1 },
          content: [{ type: "text", text: "" }],
        }),
      ).description,
    ).toBe("1 match")
  })

  test("keeps segment-safe contained tool paths relative", () => {
    expect(toolPath("..cache/result.txt", { directory: "/work/project" })).toBe("..cache/result.txt")
    expect(toolPath("../shared/result.txt", { directory: "/work/project" })).toBe("/work/shared/result.txt")
  })
})
