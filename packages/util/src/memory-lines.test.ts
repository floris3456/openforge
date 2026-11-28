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

test("reads a decision, with and without the task it was noted in", () => {
  expect(
    MemoryLines.entry(
      "- [478p7693cnd7] Which colour does the lead's badge take? Answer: Violet, like decisions. Note: violet reads well on the dark (decision of Dashboard, noted as owner, in task yb7ybhc6jpwf; global; 2026-11-28; basis: The person's answer in review, round 1)",
    ),
  ).toEqual({
    id: "478p7693cnd7",
    text: "Which colour does the lead's badge take? Answer: Violet, like decisions. Note: violet reads well on the dark",
    kind: "decision",
    person: "Dashboard",
    role: "owner",
    task: "yb7ybhc6jpwf",
    author: "decision of Dashboard, noted as owner, in task yb7ybhc6jpwf",
    scope: "global",
    day: "2026-11-28",
    basis: "The person's answer in review, round 1",
  })
  expect(
    MemoryLines.entry(
      "- [wkkqgyfbm9pc] The red dotted line is enough for a blocked step: no extra label. (decision of key-ca59, noted as build; global; 2026-11-28; basis: his words in the chat on this, read as a rule for every agent)",
    ),
  ).toEqual({
    id: "wkkqgyfbm9pc",
    text: "The red dotted line is enough for a blocked step: no extra label.",
    kind: "decision",
    person: "key-ca59",
    role: "build",
    author: "decision of key-ca59, noted as build",
    scope: "global",
    day: "2026-11-28",
    basis: "his words in the chat on this, read as a rule for every agent",
  })
})

test("reads a person's words with what they answered or where they were found, and how they were read", () => {
  const answering =
    "- [ykgknrcrp0hh] Yes totally agree. (words of Main, noted as build, answering \"I'll write it after tonight's two deploys, unless you'd rather I didn't.\", read as: approved without a spec review; build it; global; 2026-11-28)"
  expect(MemoryLines.entry(answering)).toEqual({
    id: "ykgknrcrp0hh",
    text: "Yes totally agree.",
    kind: "words",
    person: "Main",
    role: "build",
    answering: "I'll write it after tonight's two deploys, unless you'd rather I didn't.",
    read: "approved without a spec review; build it",
    author:
      "words of Main, noted as build, answering \"I'll write it after tonight's two deploys, unless you'd rather I didn't.\", read as: approved without a spec review; build it",
    scope: "global",
    day: "2026-11-28",
  })
  expect(
    MemoryLines.entry(
      '- [s7tr1p3sabcd] the stripes are weird (words of key-4h8s, noted as build, found in the person\'s reply on task t8n2k4m7q9xz, round 1, item 1, to: "The new bumper follows the drawing closely.", read as: his words on it; role build; 2026-11-28)',
    ),
  ).toEqual({
    id: "s7tr1p3sabcd",
    text: "the stripes are weird",
    kind: "words",
    person: "key-4h8s",
    role: "build",
    found:
      'the person\'s reply on task t8n2k4m7q9xz, round 1, item 1, to: "The new bumper follows the drawing closely."',
    read: "his words on it",
    author:
      'words of key-4h8s, noted as build, found in the person\'s reply on task t8n2k4m7q9xz, round 1, item 1, to: "The new bumper follows the drawing closely.", read as: his words on it',
    scope: "role build",
    day: "2026-11-28",
  })
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
