export * as MemoryLines from "./memory-lines.js"

/**
 * Memory's text as CLIProxyPacer writes it for a model (workspace reference `docs/reference/cpp-tools-api.md`), read
 * back for showing (spec notice-view, section 2). An entry is one line:
 *
 *   - [id] text (verified by P as R; scope; YYYY-MM-DD; basis: …)
 *
 * with `words of P, noted as R` for a person's words, `decision of P, noted as R[, in task T]` for his ruling
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
  /** Its kind with who wrote it, as written: `verified by P as R`, `words of P, noted as R`, `decision of P, …`. */
  readonly author: string
  /** For a decision: the task it was noted in, when its line names one. */
  readonly task?: string
  /** `global`, `role R`, or `task T` with `, subtask S`. */
  readonly scope: string
  /** YYYY-MM-DD */
  readonly day: string
  readonly basis?: string
}

export type Line = { readonly type: "entry"; readonly entry: Entry } | { readonly type: "text"; readonly text: string }

const ENTRY =
  /^- \[([^\]]+)\] (.*?) \(((?:(verified|unverified) by (.+?) as (.+?))|(?:words of (.+?), noted as (.+?))|(?:decision of (.+?), noted as (.+?)(?:, in task ([^\s;,]+))?)); (global|role .+?|task .+?); (\d{4}-\d{2}-\d{2})(?:; basis: (.*))?\)$/

/** One line read as an entry; `undefined` when it is not one as openforge writes it. */
export function entry(line: string): Entry | undefined {
  const match = ENTRY.exec(line)
  if (!match) return undefined
  const kind: Kind =
    match[4] === "verified" || match[4] === "unverified" ? match[4] : match[7] === undefined ? "decision" : "words"
  // Where the kind's person is matched; its role follows it.
  const who = { verified: 5, unverified: 5, words: 7, decision: 9 }[kind]
  return {
    id: match[1],
    text: match[2],
    kind,
    person: match[who] ?? "",
    role: match[who + 1] ?? "",
    author: match[3],
    ...(match[11] === undefined ? {} : { task: match[11] }),
    scope: match[12],
    day: match[13],
    ...(match[14] === undefined ? {} : { basis: match[14] }),
  }
}

/** A text's lines in order, each an entry or the line as it is. */
export function lines(text: string): Line[] {
  return text.split("\n").map((line) => {
    const read = entry(line)
    return read ? { type: "entry", entry: read } : { type: "text", text: line }
  })
}
