import { describe, expect, test } from "bun:test"
import { MemoryTask } from "@opencode/core/memory/task"

// Where openforge keeps a chat's task for its own hooks: CPP's place, copied into the session's metadata.

describe("MemoryTask", () => {
  test("reads the chat's task from the metadata, and nothing from anything else", () => {
    expect(MemoryTask.inside({ memory: { task: "a" } })).toEqual({ task: "a" })
    expect(MemoryTask.inside({ memory: { task: "a", subtask: "b" }, other: 1 })).toEqual({ task: "a", subtask: "b" })
    const others: Array<Parameters<typeof MemoryTask.inside>[0]> = [
      undefined,
      {},
      { memory: "a" },
      { memory: { subtask: "b" } },
      { memory: { task: 1 } },
    ]
    for (const metadata of others) expect(MemoryTask.inside(metadata)).toBeUndefined()
  })

  test("places a chat inside a task or none, keeping the other metadata", () => {
    expect(MemoryTask.placed({ other: 1, memory: { task: "a" } }, { task: "b", subtask: "c" })).toEqual({
      other: 1,
      memory: { task: "b", subtask: "c" },
    })
    expect(MemoryTask.placed({ other: 1, memory: { task: "a" } }, undefined)).toEqual({ other: 1 })
    expect(MemoryTask.placed(undefined, { task: "b" })).toEqual({ memory: { task: "b" } })
  })

  test("reads CPP's place as the metadata keeps it, and tells whether the metadata says it already", () => {
    expect(MemoryTask.fromPlace(null)).toBeUndefined()
    expect(MemoryTask.fromPlace({ task: "a", subtask: null })).toEqual({ task: "a" })
    expect(MemoryTask.fromPlace({ task: "a", subtask: "b" })).toEqual({ task: "a", subtask: "b" })
    expect(MemoryTask.at({ memory: { task: "a", subtask: "b" } }, { task: "a", subtask: "b" })).toBe(true)
    expect(MemoryTask.at({ memory: { task: "a" } }, { task: "a", subtask: "b" })).toBe(false)
    expect(MemoryTask.at({}, undefined)).toBe(true)
    expect(MemoryTask.at({ memory: { task: "a" } }, undefined)).toBe(false)
  })
  test("tells a call that makes a goal from every other task call", () => {
    expect(MemoryTask.goalCall("task", { kind: "goal", title: "Board" })).toBe(true)
    for (const [name, input] of [
      ["task", { title: "Board UI", goal: "g1" }],
      ["task", { id: "t1", goal: "g1" }],
      ["task", { id: "g1", title: "Board" }],
      ["task", {}],
      ["task", undefined],
      ["task", "kind goal"],
      ["remember", { kind: "goal" }],
      // A task turned into a goal is a task call that may move the chat (the later items).
      ["task", { id: "t4", kind: "goal" }],
    ] as const)
      expect(MemoryTask.goalCall(name, input)).toBe(false)
  })
  test("tells a call that turns a task into a goal, and finds the goal's title in CPP's data", () => {
    expect(MemoryTask.promotion("task", { id: "t4", kind: "goal" })).toBe(true)
    expect(MemoryTask.promotion("task", { kind: "goal", title: "Board" })).toBe(false)
    expect(MemoryTask.promotion("task", { id: "t4", goal: "g1" })).toBe(false)
    expect(MemoryTask.promotion("remember", { id: "t4", kind: "goal" })).toBe(false)
    expect(MemoryTask.promotedTitle([{ goal: { id: "t4", title: "Board" } }], "t4")).toBe("Board")
    expect(MemoryTask.promotedTitle({ task: { id: "t4", title: "Board" } }, "t4")).toBe("Board")
    expect(MemoryTask.promotedTitle([{ task: { id: "t9", title: "Other" } }], "t4")).toBeUndefined()
    expect(MemoryTask.promotedTitle([{ goal: { id: "t4", title: " " } }], "t4")).toBeUndefined()
    expect(MemoryTask.promotedTitle(null, "t4")).toBeUndefined()
  })
})
