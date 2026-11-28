import { expect, test } from "bun:test"
import { MemoryLines } from "@opencode/util/memory-lines"

// The TUI reads memory's entries back from the text a chat was given (spec notice-view, section 2). CLIProxyPacer
// writes those texts now (workspace reference `docs/reference/cpp-tools-api.md`); these are the forms it writes, as
// openforge 0.0.42 wrote them, which the reader must read back to the entry's fields.

const forms = [
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; global; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    entry: {
      kind: "verified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "global",
      basis: "16:13Z (2 min before); login.sh refused [98 s]",
    },
  },
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; global; 2026-11-13)",
    entry: {
      kind: "verified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "global",
      basis: undefined,
    },
  },
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (unverified by Main as build; global; 2026-11-13; basis: told so by the lead (2026-11-12))",
    entry: {
      kind: "unverified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "global",
      basis: "told so by the lead (2026-11-12)",
    },
  },
  {
    line: '- [7k9fxkcbmav3] "Sounds good" (words of Ada, noted as cpp lead; global; 2026-11-13)',
    entry: { kind: "words", person: "Ada", role: "cpp lead", text: '"Sounds good"', scope: "global", basis: undefined },
  },
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; role build; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    entry: {
      kind: "verified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "role build",
      basis: "16:13Z (2 min before); login.sh refused [98 s]",
    },
  },
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; task t8n2k4m7q9xz; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    entry: {
      kind: "verified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "task t8n2k4m7q9xz",
      basis: "16:13Z (2 min before); login.sh refused [98 s]",
    },
  },
  {
    line: "- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; task t8n2k4m7q9xz, subtask s4m7q9xzt8n2; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    entry: {
      kind: "verified",
      person: "Main",
      role: "build",
      text: "Run [it] (twice; once cold); then drop it",
      scope: "task t8n2k4m7q9xz, subtask s4m7q9xzt8n2",
      basis: "16:13Z (2 min before); login.sh refused [98 s]",
    },
  },
  // A person's words as CLIProxyPacer writes them since 2026-11-19: what they answered, or where they were found, and
  // how the agent read them.
  {
    line: "- [7k9fxkcbmav3] Yes totally agree. (words of Main, noted as build, answering \"I'll write it after tonight's two deploys, unless you'd rather I didn't.\", read as: approved without a spec review; build it; global; 2026-11-13)",
    entry: {
      kind: "words",
      person: "Main",
      role: "build",
      text: "Yes totally agree.",
      scope: "global",
      answering: "I'll write it after tonight's two deploys, unless you'd rather I didn't.",
      read: "approved without a spec review; build it",
    },
  },
  {
    line: '- [7k9fxkcbmav3] the stripes are weird (words of key-4h8s, noted as build, found in the person\'s reply on task t8n2k4m7q9xz, round 1, item 1, to: "The new bumper follows the drawing closely.", read as: his words on it; role build; 2026-11-13)',
    entry: {
      kind: "words",
      person: "key-4h8s",
      role: "build",
      text: "the stripes are weird",
      scope: "role build",
      found:
        'the person\'s reply on task t8n2k4m7q9xz, round 1, item 1, to: "The new bumper follows the drawing closely."',
      read: "his words on it",
    },
  },
  // A decision, the person's ruling (workspace spec `docs/specs/decisions-in-memory.md`), as CLIProxyPacer writes it
  // from 2026-11-28: the server's own record of a review answer names the task it was noted in, a lead's may not.
  {
    line: "- [7k9fxkcbmav3] Which colour does the lead's badge take? Answer: Violet, like decisions. Note: violet reads well on the dark (decision of Dashboard, noted as owner, in task yb7ybhc6jpwf; global; 2026-11-13; basis: The person's answer in review, round 1)",
    entry: {
      kind: "decision",
      person: "Dashboard",
      role: "owner",
      task: "yb7ybhc6jpwf",
      text: "Which colour does the lead's badge take? Answer: Violet, like decisions. Note: violet reads well on the dark",
      scope: "global",
      basis: "The person's answer in review, round 1",
    },
  },
  {
    line: "- [7k9fxkcbmav3] No push, release or deploy without the owner saying so. (decision of key-ca59, noted as build; global; 2026-11-13; basis: his words in the chat on this, read as a rule for every agent)",
    entry: {
      kind: "decision",
      person: "key-ca59",
      role: "build",
      text: "No push, release or deploy without the owner saying so.",
      scope: "global",
      basis: "his words in the chat on this, read as a rule for every agent",
    },
  },
]

test.each(forms.map((item) => [item.line, item.entry] as const))("reads back %s", (line, entry) => {
  const read = MemoryLines.entry(line)
  expect(read).toMatchObject({
    id: "7k9fxkcbmav3",
    text: entry.text,
    kind: entry.kind,
    person: entry.person,
    role: entry.role,
    scope: entry.scope,
    day: "2026-11-13",
  })
  expect(read?.basis).toBe(entry.basis)
  expect(read?.task).toBe(entry.task)
  expect([read?.answering, read?.found, read?.read]).toEqual([entry.answering, entry.found, entry.read])
  expect(line).toContain(`(${read?.author}; `)
})

test("reads a prompt's message and a start block as their lines, the entries among them", () => {
  expect(
    MemoryLines.lines(
      "Memory holds these entries close to this prompt; they may be wrong or out of date:\n- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; global; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])\n- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; role build; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])",
    ).map((line) => line.type),
  ).toEqual(["text", "entry", "entry"])
  expect(
    MemoryLines.lines(
      "Memory: what agents and people of this project noted earlier. It may be wrong or out of date; the code, the evidence and the person's words in this chat win over it.\nWhat memory holds nearest to this prompt; it may not be about it:\n- [7k9fxkcbmav3] Run [it] (twice; once cold); then drop it (verified by Main as build; global; 2026-11-13; basis: 16:13Z (2 min before); login.sh refused [98 s])\nMemory holds 58 global entries and 14 of role build; recall finds them.\nKeep it true as you work: replace an entry you find wrong, or an unverified one you have now checked (remember with supersedes), and remember only what a later chat could not get from the project's files, such as a trap you ran into or a rule the person gives; what you changed is in the files.",
    ).map((line) => line.type),
  ).toEqual(["text", "text", "entry", "text", "text"])
  // A page of recall's decisions alone, as CLIProxyPacer answers it.
  expect(
    MemoryLines.lines(
      "Decisions in memory that match the query, 1 to 2 of 4. The search was by word only, not by meaning.\n- [wkkqgyfbm9pc] The red dotted line is enough for a blocked step: no extra label. (decision of key-ca59, noted as build; global; 2026-11-28; basis: his words in the chat on this, read as a rule for every agent)\n- [478p7693cnd7] Which colour does the lead's badge take? Answer: Violet, like decisions. Note: violet reads well on the dark (decision of Dashboard, noted as owner, in task yb7ybhc6jpwf; global; 2026-11-28; basis: The person's answer in review, round 1)\n2 more: recall again with offset 2.",
    ).map((line) => (line.type === "entry" ? `${line.entry.kind} ${line.entry.id}` : "text")),
  ).toEqual(["text", "decision wkkqgyfbm9pc", "decision 478p7693cnd7", "text"])
})
