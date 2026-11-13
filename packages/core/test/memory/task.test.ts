import { describe, expect, test } from "bun:test"
import type { MemoryClient } from "@opencode/core/memory/client"
import { MemoryTask } from "@opencode/core/memory/task"
import { MemoryText } from "@opencode/core/memory/text"

const at = Date.UTC(2026, 10, 13)
const who = { person: "floris", role: "build", chat: "ses_lead" }
const task = (fields: Partial<MemoryClient.Task> = {}): MemoryClient.Task => ({
  id: "t8n2k4m7q9xz",
  parent: null,
  title: "Move the checks",
  description: "",
  state: "todo",
  note: null,
  by: who,
  worker: null,
  at,
  changed: at,
  ...fields,
})
const entry = (id: string, text: string): MemoryClient.Entry => ({
  id,
  kind: "verified",
  text,
  basis: "ls",
  scope: "task",
  role: null,
  task: "t8n2k4m7q9xz",
  subtask: null,
  by: who,
  at,
  supersedes: null,
  superseded_by: null,
  deleted: null,
})

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
    expect(MemoryTask.placeOf(task())).toEqual({ task: "t8n2k4m7q9xz" })
    expect(MemoryTask.placeOf(task({ id: "s", parent: "t8n2k4m7q9xz" }))).toEqual({
      task: "t8n2k4m7q9xz",
      subtask: "s",
    })
  })
})

describe("MemoryText tasks", () => {
  test("a task entry's scope names the task, and the subtask it was written in", () => {
    expect(MemoryText.scopeOf(entry("e1", "x"))).toBe("task t8n2k4m7q9xz")
    expect(MemoryText.scopeOf({ ...entry("e1", "x"), subtask: "s" })).toBe("task t8n2k4m7q9xz, subtask s")
  })

  test("the task part leaves out the oldest entries first, then cuts the description from its end", () => {
    const entries = Array.from({ length: 4 }, (_, index) => entry(`e${index}`, "x".repeat(900)))
    const part = MemoryText.task({ task: task({ description: "d".repeat(300) }), entries })
    expect([...part].length).toBeLessThanOrEqual(MemoryText.TASK_CHARACTERS)
    expect(part).toContain("d".repeat(300))
    expect(["e0", "e1", "e2", "e3"].filter((id) => part.includes(`[${id}]`))).toEqual(["e0", "e1", "e2"])

    const long = MemoryText.task({ task: task({ description: "d".repeat(5_000) }), entries })
    expect([...long].length).toBe(MemoryText.TASK_CHARACTERS)
    expect(long).toBe([`Your task [t8n2k4m7q9xz]: Move the checks (todo)`, "d".repeat(4_000 - 50) + "…"].join("\n"))
    expect(long).not.toContain("What was noted")
  })

  test("a subtask of a task not listed stands on its own in the list", () => {
    const sub = task({ id: "s1", parent: "gone", title: "Left over", state: "active", worker: who })
    expect(MemoryText.tasks({ tasks: [sub], more: false }, () => false)).toBe(
      [
        "Open tasks of this project:",
        "- [s1] Left over (active; made by floris as build; worked on by floris as build)",
      ].join("\n"),
    )
  })

  test("the maker's line, with the note when there is one", () => {
    expect(MemoryText.ended(task({ state: "blocked", note: "wrong file" }))).toBe(
      "Task t8n2k4m7q9xz is now blocked: wrong file.",
    )
    expect(MemoryText.ended(task({ state: "done" }))).toBe("Task t8n2k4m7q9xz is now done.")
  })
})
