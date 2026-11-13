import { describe, expect, test } from "bun:test"
import { MemoryWords } from "@opencode/core/memory/words"

// The person's messages of the two scenarios that showed the model rewording them, and one more.
const releases = "Releases moved: we cut them on Thursdays now. Update memory."
const pins = "dependency versions are always pinned exactly here, no ^ or ~ ranges"
const said = [releases, pins, "Ask me before any push.\nTags go\n  on main only."]
const quoted = (text: string, messages: ReadonlyArray<string> = said) => MemoryWords.quoted(text, messages)

describe("MemoryWords.normal", () => {
  test("lower-cases, drops the quote marks and splits on any white space", () => {
    expect(MemoryWords.normal(` "It's" \`x\` ‘a’ “B” «c»\n\td  `)).toEqual(["its", "x", "a", "b", "c", "d"])
  })
})

describe("MemoryWords.quoted", () => {
  test("a whole message, and a part from its start, middle or end", () => {
    expect(quoted(releases)).toBe(true)
    expect(quoted(pins)).toBe(true)
    expect(quoted("Releases moved")).toBe(true)
    expect(quoted("we cut them on Thursdays now.")).toBe(true)
    expect(quoted("Update memory.")).toBe(true)
  })

  test("the punctuation after the last word may be missing, there, or another", () => {
    expect(quoted("we cut them on Thursdays now")).toBe(true)
    expect(quoted("Releases moved.")).toBe(true)
    expect(quoted("we cut them on Thursdays now!")).toBe(true)
    expect(quoted("dependency versions are always pinned exactly here:")).toBe(true)
    // Only after the last word: one inside must be as written.
    expect(quoted("Releases moved we cut them")).toBe(false)
    expect(quoted("Releases moved:: we")).toBe(false)
  })

  test("another case and other quote marks", () => {
    expect(quoted("RELEASES MOVED: WE CUT THEM")).toBe(true)
    expect(quoted("“Releases moved: we cut them on ‘Thursdays’ now.”")).toBe(true)
    expect(quoted("«ask me» before any `push`")).toBe(true)
  })

  test("a line break or more white space inside the person's message or the text", () => {
    expect(quoted("Ask me before any push. Tags go on main only.")).toBe(true)
    expect(quoted("Tags go on\nmain   only")).toBe(true)
  })

  test("parts left out with [...] or … on its own, in order in one message", () => {
    expect(quoted("Releases moved: [...] on Thursdays now.")).toBe(true)
    expect(quoted("Releases moved … Update memory.")).toBe(true)
    expect(quoted("dependency versions [...] pinned exactly [...] no ^ or ~ ranges")).toBe(true)
    // Each part may end where the person's sentence goes on.
    expect(quoted("Releases moved [...] Thursdays now [...] memory")).toBe(true)
  })

  test("parts in the wrong order, or from two messages, are refused", () => {
    expect(quoted("on Thursdays now. [...] Releases moved:")).toBe(false)
    expect(quoted("Releases moved: [...] pinned exactly here")).toBe(false)
    // A part may not take words the part before it took.
    expect(quoted("we cut them [...] cut them on Thursdays")).toBe(false)
  })

  test("an empty text or an empty part is refused", () => {
    expect(quoted("")).toBe(false)
    expect(quoted("  “”  ")).toBe(false)
    expect(quoted("[...]")).toBe(false)
    expect(quoted("[...] Releases moved")).toBe(false)
    expect(quoted("Releases moved …")).toBe(false)
    expect(quoted("Releases moved [...] … on Thursdays")).toBe(false)
  })

  test("a reworded text is refused", () => {
    expect(quoted("Releases are cut on Thursdays.")).toBe(false)
    expect(quoted("Dependency versions are always pinned exactly in this project, with no ^ or ~ ranges.")).toBe(false)
    expect(quoted("Releases moved: we cut them on Thursday now.")).toBe(false)
  })

  test("only the messages given count: words of another text are refused", () => {
    // What the assistant or memory's start block said, when only the person's messages are given.
    expect(quoted("Releases are cut on Thursdays.", ["Releases are cut on Thursdays."])).toBe(true)
    expect(quoted("Releases are cut on Thursdays.", [releases])).toBe(false)
    expect(quoted("Releases moved", [])).toBe(false)
  })
})
