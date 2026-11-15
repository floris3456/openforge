import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  executeCallSummary,
  finiteNumber,
  taskCallLabel,
  primitiveInputSummary,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "task",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

test("labels a task call that makes a goal, turns a task into one or files a found task, and no other call", () => {
  expect(taskCallLabel("task", { kind: "goal", title: " Board\n UI " })).toBe("Goal: Board UI")
  expect(taskCallLabel("task", { kind: "goal" })).toBe("Goal")
  expect(taskCallLabel("task", { title: "Board UI", goal: "g1" })).toBeUndefined()
  expect(taskCallLabel("task", { id: "t1", goal: "g1" })).toBeUndefined()
  expect(taskCallLabel("remember", { kind: "goal", title: "x" })).toBeUndefined()
  expect(taskCallLabel("task", undefined)).toBeUndefined()
  // A task turned into a goal: the title CPP's answer gave, else the task's id.
  expect(taskCallLabel("task", { id: "t4", kind: "goal" }, { id: "t4", title: " Board\n UI " })).toBe(
    "Goal from task: Board UI",
  )
  expect(taskCallLabel("task", { id: "t4", kind: "goal" })).toBe("Goal from task: t4")
  expect(taskCallLabel("task", { id: "t4", kind: "goal" }, { title: 3 })).toBe("Goal from task: t4")
  // A found task.
  expect(taskCallLabel("task", { title: " Flaky\n test ", found: true })).toBe("Found: Flaky test")
  expect(taskCallLabel("task", { found: true })).toBe("Found")
  expect(taskCallLabel("task", { title: "Flaky test", found: false })).toBeUndefined()
  expect(taskCallLabel("remember", { title: "x", found: true })).toBeUndefined()
  // Called from a Code Mode program, it shows the same.
  expect(executeCallSummary({ tool: "task", status: "completed", input: { kind: "goal", title: "Board" } })).toBe(
    "Goal: Board",
  )
  expect(
    executeCallSummary({
      tool: "task",
      status: "completed",
      input: { id: "t4", kind: "goal" },
      metadata: { title: "Board" },
    }),
  ).toBe("Goal from task: Board")
  expect(executeCallSummary({ tool: "task", status: "completed", input: { title: "Flaky", found: true } })).toBe(
    "Found: Flaky",
  )
  expect(executeCallSummary({ tool: "task", status: "completed", input: { id: "t1", goal: "g1" } })).toBe(
    "task [id=t1, goal=g1]",
  )
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Web Search via Parallel")
    expect(webSearchProviderLabel("exa")).toBe("Web Search via Exa")
    expect(webSearchProviderLabel("firecrawl")).toBe("Web Search via Firecrawl")
    expect(webSearchProviderLabel("tavily")).toBe("Web Search via Tavily")
    expect(webSearchProviderLabel("opencode")).toBe("Web Search via OpenCode")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toBe(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
