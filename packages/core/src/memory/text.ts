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
  const scope = scopeOf(item)
  // A verified entry is written when it was checked, so the day it was stored is the day it was verified.
  const basis = item.basis ? `; basis: ${item.basis}` : ""
  return `- [${item.id}] ${item.text} (${author}; ${scope}; ${day(item.at)}${basis})`
}

/** What an entry belongs to: `global`, `role <role>`, or `task <id>` with `, subtask <id>` when written in one. */
export function scopeOf(item: MemoryClient.Entry) {
  if (item.scope === "role") return `role ${item.role}`
  if (item.scope === "task") return `task ${item.task}${item.subtask ? `, subtask ${item.subtask}` : ""}`
  return "global"
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

// Chosen by the workspace's behaviour set (its evidence, memory/behaviour-1/wording): without it a cheap model saved
// or corrected nothing unasked; said more widely, a strong model noted what its own edit had just put in the files.
// A sentence on when to recall was tried there too and left out: the strong model then recalled in every chat. It
// changes only with a run of that set.
const keep =
  "Keep it true as you work: replace an entry you find wrong, or an unverified one you have now checked (remember with supersedes), and remember only what a later chat could not get from the project's files, such as a trap you ran into or a rule the person gives; what you changed is in the files."

/**
 * The start block: the opening line, the entries nearest to the prompt when there are any, what else there is, and,
 * for a chat that can save, that memory is its to keep true. It names `recall` and `remember` only for a chat that
 * has the tool: an agent's permissions may leave one out.
 */
export function block(
  started: MemoryClient.Started,
  role: string,
  tools: { readonly recall: boolean; readonly remember: boolean; readonly task: boolean },
  inside?: boolean,
) {
  // The task's title and description are the chat's assignment; what was noted in it is memory, under the opening.
  const part = started.task
    ? taskParts(started.task, started.subtask ?? undefined, tools.task)
    : { assignment: [], notes: [] }
  const tasked = inside ? `, ${started.counts.task} of this task` : ""
  const counts = `Memory holds ${started.counts.global} global ${plural(started.counts.global)} and ${started.counts.role} of role ${role}${tasked}${tools.recall ? "; recall finds them" : ""}.`
  return [
    ...part.assignment,
    opening,
    ...part.notes,
    ...(started.entries.length === 0
      ? []
      : ["What memory holds nearest to this prompt; it may not be about it:", ...started.entries.map(entry)]),
    counts,
    ...(tools.remember ? [keep] : []),
  ].join("\n")
}

/** How long the task part of a start block may be, in characters. */
export const TASK_CHARACTERS = 4_000

/**
 * The task part as `task` answers it when a chat sets a task active: the chat's task, or its subtask with the task it
 * is part of, then what was said with their changes of state and what was noted in the task.
 */
export function task(started: Read, subtask?: Said) {
  const part = taskParts(started, subtask, true)
  return [...part.assignment, ...part.notes].join("\n")
}

/** What a chat inside a task does with its state, for a chat that has the `task` tool. */
export const states =
  "If it cannot be done as written, set it blocked with what is wrong (the task tool) and stop. When the work is there, set it review."

/** How many changes of state the task part shows the notes of. */
export const SAID = 5

type Said = { readonly task: MemoryClient.Task; readonly changes: ReadonlyArray<MemoryClient.Change> }
type Read = Said & { readonly entries: ReadonlyArray<MemoryClient.Entry> }

/**
 * The task part's lines: the assignment (the task or subtask, the task it is part of, the description, and with
 * `states` what to do with the task's state) and the notes (what was said with the changes of state that have a note,
 * at most {@link SAID}, the subtask's before the task's; then what was noted in the task). Together within
 * {@link TASK_CHARACTERS}: the noted entries go from the oldest, then the said lines from the oldest, then the
 * description is cut from its end; the rest is never cut.
 */
function taskParts(started: Read, subtask: Said | undefined, withStates: boolean) {
  const own = subtask?.task ?? started.task
  const head = [
    `Your task [${own.id}]: ${own.title} (${own.state})`,
    ...(subtask ? [`Part of task [${started.task.id}]: ${started.task.title}.`] : []),
  ]
  const noted = (changes: ReadonlyArray<MemoryClient.Change>) => changes.filter((change) => change.note)
  const said = [...noted(subtask?.changes ?? []), ...noted(started.changes)].slice(0, SAID)
  const parts = (
    description: string,
    changes: ReadonlyArray<MemoryClient.Change>,
    entries: ReadonlyArray<MemoryClient.Entry>,
  ) => ({
    assignment: [...head, ...(description ? [description] : []), ...(withStates ? [states] : [])],
    notes: [
      ...(changes.length
        ? [
            "Said with the task's changes of state, newest first:",
            ...changes.map((change) => `- ${day(change.at)} ${change.state} by ${who(change.by)}: ${change.note}`),
          ]
        : []),
      ...(entries.length ? ["What was noted in the task, newest first:", ...entries.map(entry)] : []),
    ],
  })
  const fits = (part: ReturnType<typeof parts>) =>
    [...[...part.assignment, ...part.notes].join("\n")].length <= TASK_CHARACTERS
  for (let count = started.entries.length; count >= 0; count--) {
    const part = parts(own.description, said, started.entries.slice(0, count))
    if (fits(part)) return part
  }
  for (let count = said.length - 1; count >= 0; count--) {
    const part = parts(own.description, said.slice(0, count), [])
    if (fits(part)) return part
  }
  // What is left for the description, with its line break and the cut's mark.
  const bare = parts("", [], [])
  const room = TASK_CHARACTERS - [...[...bare.assignment, ...bare.notes].join("\n")].length - 2
  return parts(room > 0 ? [...own.description].slice(0, room).join("") + "…" : "", [], [])
}

/** `task`'s list: each task with its subtasks indented under it. */
export function tasks(list: MemoryClient.TaskList, stopped: (task: MemoryClient.Task) => boolean) {
  if (list.tasks.length === 0) return "No open tasks."
  const ids = new Set(list.tasks.map((item) => item.id))
  const line = (item: MemoryClient.Task) =>
    `- [${item.id}] ${item.title} (${item.state === "active" && stopped(item) ? "active; its chat is not running" : item.state}; made by ${who(item.by)}${item.worker ? `; worked on by ${who(item.worker)}` : ""})`
  return [
    "Open tasks of this project:",
    // A subtask whose task is not listed (done) stands on its own.
    ...list.tasks
      .filter((item) => !item.parent || !ids.has(item.parent))
      .flatMap((item) => [
        line(item),
        ...list.tasks.filter((sub) => sub.parent === item.id).map((sub) => `  ${line(sub)}`),
      ]),
    ...(list.more ? ["There are more: only the newest 200 are listed."] : []),
  ].join("\n")
}

/** `task`'s answer for one task: what it is, its subtasks, its changes and its entries. */
export function read(found: MemoryClient.TaskRead) {
  const item = found.task
  return [
    `Task ${item.id}: ${item.title} (${item.state}${item.note ? `: ${item.note}` : ""}; made by ${who(item.by)}, ${day(item.at)}${item.worker ? `; worked on by ${who(item.worker)}` : ""})`,
    ...(item.parent ? [`Subtask of ${item.parent}.`] : []),
    ...(item.description ? [item.description] : []),
    ...(found.subtasks.length
      ? ["Subtasks:", ...found.subtasks.map((sub) => `- [${sub.id}] ${sub.title} (${sub.state})`)]
      : []),
    ...(found.changes.length
      ? [
          "Changes, newest first:",
          ...found.changes.map(
            (change) =>
              `- ${day(change.at)} ${change.state} by ${who(change.by)}${change.note ? `: ${change.note}` : ""}`,
          ),
        ]
      : []),
    ...(found.entries.length ? ["Entries:", ...found.entries.map(entry)] : []),
    ...(item.state === "todo"
      ? [`Nobody works on it yet: start a subagent with taskID "${item.id}", or set it active to work on it yourself.`]
      : []),
  ].join("\n")
}

/** What `task` adds when it makes a task: how a subagent comes to work on it. */
export function started(id: string) {
  return `A subagent works on it when you start it with taskID "${id}".`
}

/** The line a subagent's maker gets when the task it was started on is no longer active. */
export function ended(item: MemoryClient.Task) {
  return `Task ${item.id} is now ${item.state}${item.note ? `: ${item.note}` : ""}.`
}

function who(by: { readonly person: string; readonly role: string }) {
  return `${by.person} as ${by.role}`
}

function day(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

/** The start block of a new chat while memory cannot be reached. */
export const unavailable = "Memory is unavailable right now, so this chat starts without it."

function plural(count: number) {
  return count === 1 ? "entry" : "entries"
}
