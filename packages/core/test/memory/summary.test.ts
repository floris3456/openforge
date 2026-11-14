import { describe, expect, test } from "bun:test"
import { MemorySummary } from "@opencode/core/memory/summary"

const parts = MemorySummary.parts
/** A paragraph of exactly `length` code points. */
const paragraph = (mark: string, length: number) => mark.repeat(length)

describe("MemorySummary.parts", () => {
  test("one part per heading line, # to ######, with the text under it up to the next", () => {
    expect(
      parts(
        "## Goal\nShip the summary.\n\n### Done\n- parts\n- tests\n# Next\nRelease.\n###### Deep\nsix\n####### Seven\nnot a heading",
      ),
    ).toEqual([
      "## Goal\nShip the summary.",
      "### Done\n- parts\n- tests",
      "# Next\nRelease.",
      "###### Deep\nsix\n####### Seven\nnot a heading",
    ])
    // A heading needs its space; a `#` inside a line or without one is text.
    expect(parts("#Goal\ntext\n## Next\nmore\nsee # here")).toEqual(["#Goal\ntext", "## Next\nmore\nsee # here"])
  })

  test("the text before the first heading is a part; a part with nothing but its heading is left out", () => {
    expect(parts("Before.\n\n## Empty\n\n   \n## Full\ntext\n## Last")).toEqual(["Before.", "## Full\ntext"])
    expect(parts("\n\n## Goal\ntext")).toEqual(["## Goal\ntext"])
    expect(parts("")).toEqual([])
    expect(parts("## Only\n\n## Headings")).toEqual([])
  })

  test("a summary without headings is one part", () => {
    expect(parts("The user asked for a plan.\n\nIt was made.")).toEqual(["The user asked for a plan.\n\nIt was made."])
  })

  test("without the person's earlier messages that CLIProxyPacer keeps after it, and the blank line before them", () => {
    const earlier =
      "\n\n<earlier-user-messages>\n1. Plan a dark mode.\n## Not a heading of the summary\n</earlier-user-messages>"
    expect(parts(`## Goal\nDark mode.${earlier}`)).toEqual(["## Goal\nDark mode."])
    expect(parts(`Summary.${earlier}`)).toEqual(["Summary."])
    expect(parts(earlier)).toEqual([])
  })

  test("a part longer than 2,000 is cut at its blank lines, its paragraphs packed in order", () => {
    const [a, b, c] = [paragraph("a", 900), paragraph("b", 900), paragraph("c", 900)]
    const cut = parts(`## Long\n${a}\n\n${b}\n \n${c}`)
    expect(cut).toEqual([`## Long\n${a}\n\n${b}`, c])
    expect(cut.every((part) => [...part].length <= MemorySummary.CHARACTERS)).toBe(true)
    // Exactly 2,000 stays whole.
    const whole = `## H\n${paragraph("x", 2_000 - 5)}`
    expect(parts(whole)).toEqual([whole])
  })

  test("a paragraph longer than 2,000 is cut at 2,000 code points", () => {
    const long = paragraph("😀", 4_500)
    const cut = parts(`## Long\n\n${long}`)
    expect(cut.map((part) => [...part].length)).toEqual([7, 2_000, 2_000, 500])
    expect(cut.slice(1).join("")).toBe(long)
    expect(cut[0]).toBe("## Long")
  })

  test("at most 16 parts, the first", () => {
    const summary = Array.from({ length: 20 }, (_, index) => `## Part ${index}\ntext ${index}`).join("\n")
    const cut = parts(summary)
    expect(cut).toHaveLength(MemorySummary.PARTS)
    expect(cut[0]).toBe("## Part 0\ntext 0")
    expect(cut.at(-1)).toBe("## Part 15\ntext 15")
  })
})
