export * as MemoryText from "./text.js"

import type { MemoryClient } from "./client.js"

// What a model reads of memory: an entry as `recall` and the start block show it, `recall`'s answer, and the start
// block. Every character here is paid for in every chat that reads it, so an entry is one line and nothing is scored.

/** One entry: its id, its text, its kind with who wrote it, its scope, its date and its basis. */
export function entry(item: MemoryClient.Entry) {
  const author =
    item.kind === "words"
      ? `words of ${item.by.person}, noted as ${item.by.role}`
      : `${item.kind} by ${item.by.person} as ${item.by.role}`
  const scope = item.scope === "role" ? `role ${item.role}` : item.scope === "task" ? `task ${item.task}` : "global"
  // A verified entry is written when it was checked, so the day it was stored is the day it was verified.
  const day = new Date(item.at).toISOString().slice(0, 10)
  const basis = item.basis ? `; basis: ${item.basis}` : ""
  return `- [${item.id}] ${item.text} (${author}; ${scope}; ${day}${basis})`
}

/** `recall`'s answer. */
export function recall(found: MemoryClient.Found) {
  if (found.entries.length === 0) return "Memory holds nothing for this."
  const by = found.meaning ? "" : " The search was by word only, not by meaning."
  return [
    `The entries in memory nearest to the query; they may not be about it, and may be wrong or out of date.${by}`,
    ...found.entries.map(entry),
  ].join("\n")
}

const opening =
  "Memory: what agents and people of this project noted earlier. It may be wrong or out of date; the code, the evidence and the person's words in this chat win over it."

// The two sentences below were chosen by the workspace's behaviour set (its evidence, memory/behaviour-1/wording) on a
// cheap model, which without them recalled nothing in a later step and saved or corrected nothing unasked; they
// change only with a run of that set.
const look = "look there before a step this project may have its own way for (running, testing, releasing, deploying)"
const keep =
  "Keep it true as you work: replace an entry you find wrong or have now checked (remember with supersedes), and remember what a later chat will need that the project's files do not say: a fact you had to find out, a rule the person gives."

/**
 * The start block: the opening line, the entries nearest to the prompt when there are any, what else there is, and,
 * for a chat that can save, that memory is its to keep true. It names `recall` and `remember` only for a chat that
 * has the tool: an agent's permissions may leave one out. When to recall is said only while there is something to
 * find.
 */
export function block(
  started: MemoryClient.Started,
  role: string,
  tools: { readonly recall: boolean; readonly remember: boolean },
) {
  const finds = started.counts.global + started.counts.role > 0 ? `; recall finds them: ${look}` : "; recall finds them"
  const counts = `Memory holds ${started.counts.global} global ${plural(started.counts.global)} and ${started.counts.role} of role ${role}${tools.recall ? finds : ""}.`
  return [
    opening,
    ...(started.entries.length === 0
      ? []
      : ["What memory holds nearest to this prompt; it may not be about it:", ...started.entries.map(entry)]),
    counts,
    ...(tools.remember ? [keep] : []),
  ].join("\n")
}

/** The start block of a new chat while memory cannot be reached. */
export const unavailable = "Memory is unavailable right now, so this chat starts without it."

function plural(count: number) {
  return count === 1 ? "entry" : "entries"
}
