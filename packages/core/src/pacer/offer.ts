export * as PacerOffer from "./offer.js"

import type { ToolDefinition } from "@opencode/ai/effect"
import type { PacerTools } from "./tools.js"

// What a request offers of CPP's tools, given the tools the agent may use and the chat's list: the one place that
// decides it. CPP's tools are those its lists named (`PacerTools.known`), the memory tools among them while the chat
// has memory; no name of them is written here. Pure, so it costs a pass over the definitions. A warm chat keeps what
// was decided at its latest cold point (`SessionPromptStart`).

/** upstream's own search (`tool/plugin/websearch.ts`), hidden from a chat CPP offers `web_search`: one search tool. */
const upstreamSearch = "websearch"

/** Whether the agent may use any of CPP's tools (the others are left out of its definitions by its permissions). */
export function wanted(definitions: ReadonlyArray<{ readonly name: string }>, known: PacerTools.Known) {
  return definitions.some((item) => known.has(item.name))
}

/**
 * The definitions with CPP's own in place of each of its tools the agent may use, as CPP wrote them, and without the
 * ones the chat's list leaves out (all of them without a list). upstream's `websearch` goes when CPP's `web_search`
 * takes its place. Tools CPP lists that the agent may not use stay out.
 */
export function apply(
  definitions: ReadonlyArray<ToolDefinition>,
  list: PacerTools.List | undefined,
  known: PacerTools.Known,
) {
  const search = list?.byName.has("web_search") === true && definitions.some((item) => item.name === "web_search")
  return definitions.flatMap((item) => {
    const own = known.has(item.name) ? list?.byName.get(item.name) : item
    if (own === undefined) return []
    return search && item.name === upstreamSearch ? [] : [own]
  })
}
