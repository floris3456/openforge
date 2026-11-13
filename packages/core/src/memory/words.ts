export * as MemoryWords from "./words.js"

// An entry of kind `words` is a person's exact words (the workspace's spec `docs/specs/memory.md`, section 1), so
// `remember` saves one only when its text is in what the person wrote in the chat. The comparison ignores case, quote
// marks and how white space runs; the punctuation after a part's last word may differ, so that the first part of a
// sentence can be taken; `[...]` or `…` on its own leaves words out.

const QUOTES = /["'`\u2018\u2019\u201c\u201d\u00ab\u00bb]/g
const OMITTED = new Set(["[...]", "…"])

/** Lower-cased, quote marks gone, white space collapsed: the words compared. */
export function normal(text: string) {
  return text.toLowerCase().replace(QUOTES, "").split(/\s+/).filter(Boolean)
}

/**
 * Whether `text` is the words of one of `messages`: a run of consecutive words of it, or, with words left out, runs
 * that follow each other in that order in the same message. An empty text or an empty part is not.
 */
export function quoted(text: string, messages: ReadonlyArray<string>) {
  const parts = normal(text).reduce<string[][]>(
    (all, word) => (OMITTED.has(word) ? [...all, []] : [...all.slice(0, -1), [...all.at(-1)!, word]]),
    [[]],
  )
  if (parts.some((part) => part.length === 0)) return false
  return messages.some((message) => {
    const said = normal(message)
    // The earliest place each part fits leaves the most room for the next.
    const end = parts.reduce<number | undefined>(
      (from, part) => (from === undefined ? undefined : after(part, said, from)),
      0,
    )
    return end !== undefined
  })
}

/** Where the run `part` ends in `said`, starting at `from` or later; undefined when it is not there. */
function after(part: ReadonlyArray<string>, said: ReadonlyArray<string>, from: number) {
  const bare = (word: string) => word.replace(/[.,;:!?]$/, "")
  const at = said.findIndex(
    (_, start) =>
      start >= from &&
      start + part.length <= said.length &&
      part.every((word, index) =>
        index === part.length - 1 ? bare(word) === bare(said[start + index]!) : word === said[start + index],
      ),
  )
  return at < 0 ? undefined : at + part.length
}
