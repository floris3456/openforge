export * as MemoryLines from "./memory-lines.js"

/**
 * Memory's text as CLIProxyPacer writes it for a model (workspace reference `docs/reference/cpp-tools-api.md`), read
 * back for showing (spec notice-view, section 2). An entry is one line:
 *
 *   - [id] text (verified by P as R; scope; YYYY-MM-DD; basis: …)
 *
 * with `words of P, noted as R[, found in W | , answering "A"][, read as: H]` for a person's words (where they were
 * found or what they answered, and how the agent read them), `decision of P, noted as R[, in task T]` for his ruling
 * (workspace spec `docs/specs/decisions-in-memory.md`), and a scope of `global`, `role R` or `task T[, subtask S]`. Its
 * text and basis hold no line break (CLIProxyPacer refuses one) but may hold brackets, parentheses and semicolons; the
 * first place the line reads as an entry wins.
 */

export type Kind = "verified" | "unverified" | "words" | "decision"

export type Entry = {
  readonly id: string
  readonly text: string
  readonly kind: Kind
  readonly person: string
  readonly role: string
  /** Its kind with who wrote it, as written: `verified by P as R`, `words of P, noted as R, …`, `decision of P, …`. */
  readonly author: string
  /** For a decision: the task it was noted in, when its line names one. */
  readonly task?: string
  /** For a person's words: what they answered, without its quotes. */
  readonly answering?: string
  /** For a person's words found beyond what he typed in the chat: where, and what they answered there. */
  readonly found?: string
  /** For a person's words: how the agent read them. */
  readonly read?: string
  /** `global`, `role R`, or `task T` with `, subtask S`. */
  readonly scope: string
  /** YYYY-MM-DD */
  readonly day: string
  readonly basis?: string
}

export type Line = { readonly type: "entry"; readonly entry: Entry } | { readonly type: "text"; readonly text: string }

const ENTRY =
  /^- \[(?<id>[^\]]+)\] (?<text>.*?) \((?<author>(?<checked>verified|unverified) by (?<checker>.+?) as (?<checkerRole>.+?)|words of (?<speaker>.+?), noted as (?<speakerRole>.+?)(?:, found in (?<found>.+?)|, answering "(?<answering>.*?)")?(?:, read as: (?<read>.+?))?|decision of (?<decider>.+?), noted as (?<deciderRole>.+?)(?:, in task (?<task>[^\s;,]+))?); (?<scope>global|role .+?|task .+?); (?<day>\d{4}-\d{2}-\d{2})(?:; basis: (?<basis>.*))?\)$/

/** One line read as an entry; `undefined` when it is not one as openforge writes it. */
export function entry(line: string): Entry | undefined {
  const group = ENTRY.exec(line)?.groups
  if (!group) return undefined
  const kind: Kind =
    group.checked === "verified" || group.checked === "unverified"
      ? group.checked
      : group.speaker === undefined
        ? "decision"
        : "words"
  // Which of the kinds' groups holds its person; its role is the group of that name with `Role`.
  const who = kind === "words" ? "speaker" : kind === "decision" ? "decider" : "checker"
  return {
    id: group.id ?? "",
    text: group.text ?? "",
    kind,
    person: group[who] ?? "",
    role: group[`${who}Role`] ?? "",
    author: group.author ?? "",
    ...(group.task === undefined ? {} : { task: group.task }),
    ...(group.answering === undefined ? {} : { answering: group.answering }),
    ...(group.found === undefined ? {} : { found: group.found }),
    ...(group.read === undefined ? {} : { read: group.read }),
    scope: group.scope ?? "",
    day: group.day ?? "",
    ...(group.basis === undefined ? {} : { basis: group.basis }),
  }
}

/** A text's lines in order, each an entry or the line as it is. */
export function lines(text: string): Line[] {
  return text.split("\n").map((line) => {
    const read = entry(line)
    return read ? { type: "entry", entry: read } : { type: "text", text: line }
  })
}
