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
})
