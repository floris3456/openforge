import type { WidthMethod } from "@opentui/core"
import { promptOffsetIndex } from "./display"

export function expandPastedTextPlaceholders(
  text: string,
  pasted: readonly { text: string; source: { text: string; start?: number } }[],
) {
  let cursor = 0
  let result = ""
  for (const part of pasted.toSorted((a, b) => (a.source.start ?? 0) - (b.source.start ?? 0))) {
    const index = text.indexOf(part.source.text, cursor)
    if (index === -1) continue
    result += text.slice(cursor, index) + part.text
    cursor = index + part.source.text.length
  }
  return result + text.slice(cursor)
}

export function expandTrackedPastedText(
  text: string,
  ranges: { start: number; end: number; text: string }[],
  widthMethod: WidthMethod,
) {
  return expandTrackedPastes(text, ranges, widthMethod).text
}

/**
 * The prompt with each tracked paste put back, and where each paste now stands in it (string offsets, in order), so
 * the model can get it inside `<paste>` tags.
 */
export function expandTrackedPastes(
  text: string,
  ranges: { start: number; end: number; text: string }[],
  widthMethod: WidthMethod,
) {
  const expanded = ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .reduce(
      (result, part) => {
        const start = promptOffsetIndex(text, part.start, widthMethod)
        const at = result.text.length + start - result.consumed
        return {
          text: result.text + text.slice(result.consumed, start) + part.text,
          consumed: promptOffsetIndex(text, part.end, widthMethod),
          pastes: part.text ? [...result.pastes, { start: at, end: at + part.text.length }] : result.pastes,
        }
      },
      { text: "", consumed: 0, pastes: [] as { start: number; end: number }[] },
    )
  return { text: expanded.text + text.slice(expanded.consumed), pastes: expanded.pastes }
}
