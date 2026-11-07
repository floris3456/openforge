export * as PacerOffer from "./offer.js"

import type { ToolDefinition } from "@opencode/ai/effect"
import { PacerTools } from "./tools.js"

// What a request offers of CPP's web tools, given the tools the agent may use and the chat's list: the one place that
// decides it, which the Instructions work may replace. Pure, so it costs a pass over the definitions.

const web = new Set<string>(PacerTools.names)
/** upstream's own search (`tool/plugin/websearch.ts`), hidden from a chat CPP offers `web_search`: one search tool. */
const upstreamSearch = "websearch"

/** Whether the agent may use any of CPP's tools (the others are left out of its definitions by its permissions). */
export function wanted(definitions: ReadonlyArray<{ readonly name: string }>) {
  return definitions.some((item) => web.has(item.name))
}

/**
 * The definitions with CPP's own in place of each of its tools the agent may use, as CPP wrote them, and without the
 * ones the chat's list leaves out (all of them without a list). upstream's `websearch` goes when CPP's `web_search`
 * takes its place. Tools CPP lists that the agent may not use stay out.
 */
export function apply(definitions: ReadonlyArray<ToolDefinition>, list: PacerTools.List | undefined) {
  const search = list?.byName.has("web_search") === true && definitions.some((item) => item.name === "web_search")
  return definitions.flatMap((item) => {
    const own = web.has(item.name) ? list?.byName.get(item.name) : item
    if (own === undefined) return []
    return search && item.name === upstreamSearch ? [] : [own]
  })
}
