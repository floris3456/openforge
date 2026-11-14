export * as EarlierMessages from "./earlier-messages.js"

/**
 * The list of the person's earlier messages that CLIProxyPacer appends to a summary it writes (its compaction
 * phase 4, `compaction_users.rs`), for showing under "Your earlier messages" (spec checkpoint, section 5):
 *
 *   <earlier-user-messages>
 *   <message n="1">first text…</message>
 *   <gap from="5" to="23">see the summary</gap>
 *   </earlier-user-messages>
 */

export type Entry =
  | { readonly type: "message"; readonly n: number; readonly text: string }
  | { readonly type: "gap"; readonly from: number; readonly to: number }

const OPEN = "<earlier-user-messages>"
const CLOSE = "</earlier-user-messages>"

/**
 * The summary without its list, and the list's entries, each message's text on one line; `undefined` when it holds no
 * whole list.
 */
export function split(summary: string) {
  const start = summary.lastIndexOf(OPEN)
  if (start === -1) return undefined
  const end = summary.indexOf(CLOSE, start + OPEN.length)
  if (end === -1) return undefined
  return {
    summary: (summary.slice(0, start).trimEnd() + "\n\n" + summary.slice(end + CLOSE.length).trimStart()).trim(),
    entries: parse(summary.slice(start + OPEN.length, end)),
  }
}

// As CLIProxyPacer's `parse`: the entries in order.
function parse(inner: string) {
  const pattern = /<message n="(\d+)">([\s\S]*?)<\/message>|<gap from="(\d+)" to="(\d+)">[\s\S]*?<\/gap>/g
  return Array.from(
    inner.matchAll(pattern),
    (match): Entry =>
      match[1] !== undefined
        ? { type: "message", n: Number(match[1]), text: oneLine(unescape(match[2] ?? "")) }
        : { type: "gap", from: Number(match[3]), to: Number(match[4]) },
  )
}

/** The two literals CLIProxyPacer's `escaped` wrote, back as they were typed; a `&lt;` the person typed stays. */
function unescape(text: string) {
  return text
    .replaceAll("&lt;/message", "</message")
    .replaceAll("&lt;/earlier-user-messages", "</earlier-user-messages")
}

function oneLine(text: string) {
  return text.replace(/\s*\n\s*/g, " ").trim()
}
