import { expect, test } from "bun:test"
import { MemoryLines } from "./memory-lines.js"

test("reads an entry with brackets, parentheses and semicolons in its text and basis", () => {
  expect(
    MemoryLines.entry(
      "- [7k9fxkcbmav3] Run [it] (twice; once cold) as build; then drop it (verified by Main as build; global; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    ),
  ).toEqual({
    id: "7k9fxkcbmav3",
    text: "Run [it] (twice; once cold) as build; then drop it",
    kind: "verified",
    person: "Main",
    role: "build",
    author: "verified by Main as build",
    scope: "global",
    day: "2026-11-13",
    basis: "16:13Z (2 min before); login.sh refused [98 s]",
  })
})

test("reads each kind and scope, with and without a basis", () => {
  expect(
    MemoryLines.entry("- [a1] Text (unverified by Lead as cpp lead; role build; 2026-11-14; basis: told so)"),
  ).toMatchObject({
    kind: "unverified",
    person: "Lead",
    role: "cpp lead",
    author: "unverified by Lead as cpp lead",
    scope: "role build",
    basis: "told so",
  })
  const words = MemoryLines.entry('- [b2] "Sounds good" (words of Ada, noted as build; task t8n2k4m7q9xz; 2026-11-14)')
  expect(words).toEqual({
    id: "b2",
    text: '"Sounds good"',
    kind: "words",
    person: "Ada",
    role: "build",
    author: "words of Ada, noted as build",
    scope: "task t8n2k4m7q9xz",
    day: "2026-11-14",
  })
  expect(
    MemoryLines.entry("- [c3] Sub (verified by Main as general; task t8n2k4m7q9xz, subtask s1; 2026-11-14; basis: ls)")
      ?.scope,
  ).toBe("task t8n2k4m7q9xz, subtask s1")
})

test("keeps lines that are not entries as they are", () => {
  const text = [
    "Memory holds these entries close to this prompt; they may be wrong or out of date:",
    "- [d4] An entry (verified by Main as build; global; 2026-11-14; basis: ls)",
    "- [x] a checked box in a file",
    "- [e5] No date (verified by Main as build; global)",
    "Memory holds 58 global entries and 14 of role build; recall finds them.",
  ].join("\n")
  expect(MemoryLines.lines(text).map((line) => (line.type === "entry" ? `entry ${line.entry.id}` : line.text))).toEqual(
    [
      "Memory holds these entries close to this prompt; they may be wrong or out of date:",
      "entry d4",
      "- [x] a checked box in a file",
      "- [e5] No date (verified by Main as build; global)",
      "Memory holds 58 global entries and 14 of role build; recall finds them.",
    ],
  )
})
