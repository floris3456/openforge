export * as MemorySummary from "./summary.js"

// After a compaction the start block holds the entries close to the compaction's summary (the workspace's spec
// `docs/specs/memory.md`, section 3, "After a compaction: the summary"). The summary goes to the start call in parts:
// one per Markdown heading, as the server searches each part on its own.

/** How long a part may be, in code points: a query's length. */
export const CHARACTERS = 2_000
/** How many parts a start takes. */
export const PARTS = 16

const heading = /^#{1,6} /
// The person's earlier messages CPP keeps after its summary (`compaction.user_messages`), with the blank line before.
const earlier = /(?:\n\n)?<earlier-user-messages>[\s\S]*?<\/earlier-user-messages>/g

/**
 * The summary's parts: one per heading line with the text under it, the text before the first heading too; a part
 * with nothing but its heading is left out, and a longer one is cut at its blank lines into pieces of at most
 * {@link CHARACTERS} (a longer paragraph at {@link CHARACTERS}); the first {@link PARTS}.
 */
export function parts(summary: string) {
  const sections = summary
    .replace(earlier, "")
    .split("\n")
    .reduce<string[][]>(
      (all, line) => {
        if (heading.test(line)) return [...all, [line]]
        all.at(-1)!.push(line)
        return all
      },
      [[]],
    )
  return sections
    .filter((lines) => lines.slice(heading.test(lines[0] ?? "") ? 1 : 0).some((line) => line.trim()))
    .flatMap((lines) => pieces(lines.join("\n").trim()))
    .slice(0, PARTS)
}

/** A part cut at its blank lines into pieces within {@link CHARACTERS}, paragraphs packed in order. */
function pieces(text: string) {
  if (length(text) <= CHARACTERS) return [text]
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      const points = [...paragraph]
      return Array.from({ length: Math.ceil(points.length / CHARACTERS) }, (_, index) =>
        points.slice(index * CHARACTERS, (index + 1) * CHARACTERS).join(""),
      )
    })
    .reduce<string[]>((packed, paragraph) => {
      const last = packed.at(-1)
      if (last !== undefined && length(last) + 2 + length(paragraph) <= CHARACTERS) {
        packed[packed.length - 1] = `${last}\n\n${paragraph}`
        return packed
      }
      return [...packed, paragraph]
    }, [])
}

function length(text: string) {
  return [...text].length
}
