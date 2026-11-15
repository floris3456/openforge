import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import memoryTools from "./pacer/fixtures/memory-tools.json"
import webTools from "./pacer/fixtures/tools.json"

// CPP holds the definition, rules and texts of every tool it serves (workspace spec `docs/specs/cpp-tools.md`): none
// of them is left in core's source. Its descriptions and parameters are those openforge 0.0.42 sent a model and CPP's
// web tools' list; the rules' and texts' hallmarks are the words 0.0.42's memory tools answered with.

const src = path.join(import.meta.dir, "..", "src")
const sources = [...new Bun.Glob("**/*.ts").scanSync(src)].map((file) => ({
  file,
  text: fs.readFileSync(path.join(src, file), "utf8"),
}))

/** Every description of a definition and of its parameters, at any depth. */
const descriptions = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(descriptions)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) =>
    key === "description" && typeof item === "string" ? [item] : descriptions(item),
  )
}
/** The sentences and clauses of a text long enough to be its own, not a common phrase. */
const fragments = (text: string) =>
  text
    .split(/(?<=[.:;])\s+|, /)
    .map((part) => part.trim())
    .filter((part) => part.length >= 24)

const definitions = [...memoryTools, ...webTools.tools.claude]
const words = [...new Set(definitions.flatMap((tool) => descriptions(tool).flatMap(fragments)))]

/** What 0.0.42's memory tools, start block and task check answered, by phrases no other text of core uses. */
const hallmarks = [
  "Only a lead chat",
  "This chat is in no task",
  "Task check:",
  "Memory holds",
  "memory never keeps secrets",
  "words of ",
  "a child chat replaces or deletes",
  "Subtasks in order:",
  "is worked on by",
  "Make the task first",
  "Keep it true as you work",
  "may be wrong or out of date",
]

describe("core's source", () => {
  test("holds no description or parameter of a tool CPP serves", () => {
    expect(words.length).toBeGreaterThan(40)
    const found = words.flatMap((word) =>
      sources.filter((source) => source.text.includes(word)).map((source) => `${source.file}: ${word}`),
    )
    expect(found).toEqual([])
  })

  test("holds none of the memory tools' rules or texts", () => {
    const found = hallmarks.flatMap((word) =>
      sources.filter((source) => source.text.includes(word)).map((source) => `${source.file}: ${word}`),
    )
    expect(found).toEqual([])
  })

  test("names CPP's web tools only where a name is all it needs", () => {
    const names = webTools.tools.claude.map((tool) => tool.name)
    const naming = sources.filter((source) => names.some((name) => new RegExp(`\\b${name}\\b`).test(source.text)))
    // `PacerOffer` hides upstream's own search when CPP's `web_search` takes its place; upstream's search plugins and
    // OpenAI's Responses API name their providers' own tools of that name.
    expect(naming.map((source) => source.file).toSorted()).toEqual([
      "github-copilot/responses/openai-responses-api-types.ts",
      "github-copilot/responses/openai-responses-language-model.ts",
      "github-copilot/responses/openai-responses-prepare-tools.ts",
      "pacer/offer.ts",
      "plugin/websearch/parallel.ts",
    ])
  })
})
