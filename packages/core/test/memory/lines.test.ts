import { expect, test } from "bun:test"
import { MemoryLines } from "@opencode/util/memory-lines"
import type { MemoryClient } from "@opencode/core/memory/client"
import { MemoryText } from "@opencode/core/memory/text"

// The TUI reads memory's entries back from the text a chat was given (spec notice-view, section 2): every form
// `MemoryText.entry` writes must read back to the entry's fields, so a change of that form fails here until the reader
// follows it.

const base: MemoryClient.Entry = {
  id: "7k9fxkcbmav3",
  kind: "verified",
  text: "Run [it] (twice; once cold); then drop it",
  basis: "16:13Z (2 min before); login.sh refused [98 s]",
  scope: "global",
  role: null,
  task: null,
  subtask: null,
  by: { person: "Main", role: "build", chat: "ses_main" },
  at: Date.UTC(2026, 10, 13, 16, 13),
}

const forms: MemoryClient.Entry[] = [
  base,
  { ...base, basis: null },
  { ...base, kind: "unverified", basis: "told so by the lead (2026-11-12)" },
  { ...base, kind: "words", text: '"Sounds good"', basis: null, by: { ...base.by, person: "Ada", role: "cpp lead" } },
  { ...base, scope: "role", role: "build" },
  { ...base, scope: "task", task: "t8n2k4m7q9xz" },
  { ...base, scope: "task", task: "t8n2k4m7q9xz", subtask: "s4m7q9xzt8n2" },
]

test.each(forms.map((item) => [MemoryText.entry(item), item] as const))("reads back %s", (line, item) => {
  const read = MemoryLines.entry(line)
  expect(read).toMatchObject({
    id: item.id,
    text: item.text ?? "",
    kind: item.kind,
    person: item.by.person,
    role: item.by.role,
    scope: MemoryText.scopeOf(item),
    day: "2026-11-13",
  })
  expect(read?.basis).toBe(item.basis ?? undefined)
  expect(line).toContain(`(${read?.author}; `)
})

test("reads a prompt's message and a start block as their lines, the entries among them", () => {
  const prompt = MemoryLines.lines(MemoryText.prompt([base, forms[4]]))
  expect(prompt.map((line) => line.type)).toEqual(["text", "entry", "entry"])
  const block = MemoryLines.lines(
    MemoryText.block({ entries: [base], counts: { global: 58, role: 14, task: 0 }, recall: "r1" }, "build", {
      recall: true,
      remember: true,
      task: false,
    }),
  )
  expect(block.map((line) => line.type)).toEqual(["text", "text", "entry", "text", "text"])
})
