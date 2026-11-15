import { describe, expect, test } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { PacerOffer } from "@opencode/core/pacer/offer"
import { PacerTools } from "@opencode/core/pacer/tools"
import { ownerList } from "./fake-tools"

// What the registry gives a request: openforge's own definitions, sorted by name, the placeholders of CPP's tools
// among them, as its lists named them (`PacerTools.known`).
const own = (name: string) =>
  new ToolDefinition({ name, description: `openforge's ${name}`, inputSchema: { type: "object" } })
const registered = ["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch", "websearch"].map(own)

const listOf = (names: ReadonlyArray<string>): PacerTools.List => {
  const definitions = ownerList.tools.claude
    .filter((tool) => names.includes(tool.name))
    .map(
      (tool) => new ToolDefinition({ name: tool.name, description: tool.description, inputSchema: tool.input_schema }),
    )
  return {
    version: ownerList.version,
    definitions,
    byName: new Map(definitions.map((item) => [item.name, item])),
    meta: new Map(definitions.map((item) => [item.name, PacerTools.fallback(item.name)])),
  }
}
const known: PacerTools.Known = new Map(
  ["web_search", "web_extract", "web_crawl", "web_research"].map((name) => [name, PacerTools.fallback(name)]),
)
const all = listOf(["web_search", "web_extract", "web_crawl", "web_research"])
const names = (definitions: ReadonlyArray<ToolDefinition>) => definitions.map((item) => item.name)

describe("PacerOffer.wanted", () => {
  test("is whether the agent may use any of CPP's tools", () => {
    expect(PacerOffer.wanted(registered, known)).toBe(true)
    expect(PacerOffer.wanted([own("web_crawl")], known)).toBe(true)
    expect(PacerOffer.wanted(["read", "webfetch", "websearch", "execute"].map(own), known)).toBe(false)
    expect(PacerOffer.wanted([], known)).toBe(false)
    // Before any list was read, CPP has no tools here.
    expect(PacerOffer.wanted(registered, new Map())).toBe(false)
  })
})

describe("PacerOffer.apply", () => {
  test("puts CPP's definitions in place of the tools it named, and hides upstream's websearch", () => {
    const offered = PacerOffer.apply(registered, all, known)
    expect(names(offered)).toEqual(["read", "web_crawl", "web_extract", "web_research", "web_search", "webfetch"])
    // The list's own objects: CPP's description and schema, as written.
    for (const name of ["web_crawl", "web_extract", "web_research", "web_search"])
      expect(offered.find((item) => item.name === name)).toBe(all.byName.get(name)!)
    expect(offered[0]).toBe(registered[0]!)
  })

  test("drops a tool the list leaves out, and keeps websearch when CPP offers no web_search", () => {
    const codex = listOf(["web_search"])
    expect(names(PacerOffer.apply(registered, codex, known))).toEqual(["read", "web_search", "webfetch"])
    const pages = listOf(["web_extract", "web_crawl"])
    expect(names(PacerOffer.apply(registered, pages, known))).toEqual([
      "read",
      "web_crawl",
      "web_extract",
      "webfetch",
      "websearch",
    ])
    expect(names(PacerOffer.apply(registered, listOf([]), known))).toEqual(["read", "webfetch", "websearch"])
  })

  test("drops all of them without a list, so their placeholders never reach a model", () => {
    expect(names(PacerOffer.apply(registered, undefined, known))).toEqual(["read", "webfetch", "websearch"])
  })

  test("adds nothing the agent may not use: denied tools stay out, and so do names openforge has no tool for", () => {
    // The agent's permissions deny `websearch`: the registry left out web_search, web_research and websearch.
    const fetchOnly = registered.filter((item) => !["web_search", "web_research", "websearch"].includes(item.name))
    expect(names(PacerOffer.apply(fetchOnly, all, known))).toEqual(["read", "web_crawl", "web_extract", "webfetch"])
    // web_search denied alone keeps upstream's search: the chat is not offered CPP's.
    const noSearch = registered.filter((item) => item.name !== "web_search")
    expect(names(PacerOffer.apply(noSearch, all, known))).toContain("websearch")
    const future = new ToolDefinition({ name: "web_maps", description: "maps", inputSchema: { type: "object" } })
    const listed = {
      ...all,
      definitions: [...all.definitions, future],
      byName: new Map([...all.byName, ["web_maps", future]]),
    }
    expect(names(PacerOffer.apply(registered, listed, known))).not.toContain("web_maps")
  })
})
