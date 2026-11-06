import type {
  PacerChat,
  PacerForceUse,
  PacerNextUse,
  PacerPromptChange,
  PacerPromptItem,
  PacerRequest,
  PacerWindow,
} from "@opencode/client"
import { Locale } from "../util/locale"
import { stringWidth } from "../util/string-width"

// The words and numbers CLIProxyPacer's screens print (spec cliproxypacer-step-1, sections 4, 5 and 7), as pure
// functions of openforge's own shapes and the time, so every row of the spec is one unit test.

/**
 * 1:05:09, 23:41, 0:07: what is left of a countdown, rounded up to the second. With `hours`, always hours, minutes and
 * seconds (0:59:59), as a countdown that started at an hour or more keeps down to 0:00:00.
 */
export function formatRemaining(ms: number, hours = false) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const whole = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  if (hours || whole > 0) return `${whole}:${String(minutes).padStart(2, "0")}:${rest}`
  return `${minutes}:${rest}`
}

/** Whether what is left, rounded up to the second as it shows, is an hour or more. */
export function remainingHours(ms: number) {
  return Math.ceil(ms / 1000) >= 3600
}

/** When a window resets: 1:20 (hours and minutes) within a day, else 3d 4h. */
export function formatReset(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
}

/** 14:02 on this machine's clock. */
export function clockTime(ms: number) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** 14:02:13 on this machine's clock. */
export function clockSeconds(ms: number) {
  return `${clockTime(ms)}:${String(new Date(ms).getSeconds()).padStart(2, "0")}`
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

/** $0.41, $0.0123: most cached steps cost less than a cent. */
export function formatCost(cost: number) {
  return usd.format(cost)
}

/**
 * The toolbar's cache item (section 4). `countdown` counts down to `until`; the item prints it after `text`, padded
 * so that its width holds while it counts.
 */
export interface CacheLabel {
  readonly text: string
  readonly tone: "muted" | "warning"
  readonly until?: number
}

/**
 * The cache item for a chat's view at `now`. In order: the account can't serve the next step; the cache is cold;
 * compact before cold is due; pings stopped on a failure; warming is off; the cache is warm (with pings running, it
 * counts down to `coldAt`, which holds through the pings).
 */
export function cacheLabel(chat: PacerChat, now: number): CacheLabel {
  if (chat.forceUse?.when === "now")
    return { text: `account used up · next step moves to ${chat.forceUse.account}`, tone: "warning" }
  const until = chat.coldAt ?? chat.warmUntil
  if (!chat.warm || (until !== undefined && until <= now)) return { text: "cache cold", tone: "warning" }
  if (chat.switches.compactBeforeCold && chat.compactAt !== undefined && chat.compactReason !== "cold")
    return { text: `compacts at ${clockTime(chat.compactAt)}`, tone: "muted" }
  if (until === undefined) return { text: "warm", tone: "muted" }
  if (chat.pings.failed) return { text: "keep-alive stopped · warm ", tone: "warning", until }
  if (!chat.switches.warming) return { text: "warming off · warm ", tone: "muted", until }
  return { text: "warm ", tone: "muted", until }
}

/** The cache item as one string, with its countdown unpadded. */
export function cacheText(label: CacheLabel, now: number) {
  return label.until === undefined ? label.text : label.text + formatRemaining(label.until - now)
}

/** Whether a window's reading can't be trusted at `now`: CPP said so, or it has turned stale since. */
export function windowStale(window: PacerWindow, now: number) {
  return window.stale || (window.staleAt !== undefined && window.staleAt <= now)
}

/**
 * `5h  62% left · resets 1:20`, marked when CPP calls it estimated or stale (section 5): `resets ~3d 4h` when the
 * reset is CPP's estimate, `· stale` when the reading can't be trusted. Short enough for the sidebar's 37 columns.
 */
export function windowLine(window: PacerWindow, now: number) {
  const left = window.left === undefined ? undefined : `${Math.round(window.left)}% left`
  const state = (() => {
    if (window.state === "dormant") return "not started"
    if (window.state === "awaiting-confirmation") return "reset, awaiting a reading"
    if (window.state === "unknown" && left === undefined) return "unknown"
    return undefined
  })()
  const reset =
    window.resetsAt !== undefined && window.state !== "dormant" && window.state !== "awaiting-confirmation"
      ? `resets ${window.state === "estimated" ? "~" : ""}${formatReset(window.resetsAt - now)}`
      : undefined
  const parts = [left, state, reset, windowStale(window, now) ? "stale" : undefined].filter(
    (part): part is string => part !== undefined,
  )
  return `${window.label}  ${parts.length ? parts.join(" · ") : "unknown"}`
}

/** Where the chat goes once its cache is cold, and why. */
export function nextUseLine(next: PacerNextUse) {
  const why =
    next.reason === "cold_move"
      ? "once its cache is cold"
      : next.reason === "forced_move"
        ? "its account can't keep it"
        : next.reason.replaceAll("_", " ")
  return `next: ${next.account}, ${why}`
}

/** A forced move, now or soon. */
export function forceUseLine(force: PacerForceUse) {
  return `forced move to ${force.account} ${force.when}`
}

/** What a request was: the subagent's agent for a subagent's step. */
export function requestKind(request: PacerRequest) {
  if (request.kind === "step" && request.subagent) return request.agent ?? "subagent"
  return request.kind
}

/** The verdict column: the verdict, a miss's cause and the part that changed, or why it failed. */
export function requestVerdict(request: PacerRequest) {
  if (request.refusal !== undefined) return `refused: ${request.refusal}`
  if (request.failed) return `failed ${request.status}`
  if (request.verdict === undefined) return ""
  if (!request.miss) return request.verdict
  return [request.verdict, request.cause, request.changedPart]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ")
}

/** How a row is drawn: misses as warnings, failures as errors. */
export function requestTone(request: PacerRequest): "base" | "warning" | "error" {
  if (request.failed || request.refusal !== undefined) return "error"
  if (request.miss) return "warning"
  return "base"
}

// Columns two spaces apart, sized to the rows (section 7). Each column first gets what its widest value needs, so a
// value is cut only when the line has no blank room left for it; a narrow window drops the model first, then the
// account, then the cache read and write, keeping the verdict room for a miss's cause when one needs it. Room to
// spare widens the columns to their usual widths, so a longer value arriving later still fits, and the rest goes to
// the verdict, which keeps the cost at the right edge.
const TIME = 8
const GAP = 2
/** The kind column at most: a subagent's agent name is cut beyond it. */
const KIND = 12
/** The room the verdict keeps for a miss's cause, when a verdict needs it, before a column is added. */
const VERDICT = 28
/** The fewest cells the account and the model are shown in, cut. */
const ACCOUNT = 10
const MODEL = 12
/** The usual widths, which room to spare widens the columns to, in this order. */
const USUAL = { verdict: 28, kind: 10, account: 12, model: 18, cache: 12, cost: 7 } as const

/** The width of each column of a row `width` cells wide; a column 0 cells wide isn't shown. */
export interface RequestLayout {
  readonly width: number
  readonly kind: number
  readonly model: number
  readonly account: number
  readonly cache: number
  readonly verdict: number
  readonly cost: number
}

type Cells = Record<"time" | "kind" | "model" | "account" | "cache" | "verdict" | "cost", string>

const HEADER: Cells = {
  time: "time",
  kind: "kind",
  model: "model",
  account: "account",
  cache: "read/write",
  verdict: "verdict",
  cost: "cost",
}

function requestCells(request: PacerRequest): Cells {
  return {
    time: clockSeconds(request.at),
    kind: requestKind(request),
    model: request.model,
    account: request.account ?? "–",
    cache: `${Locale.number(request.tokens.cacheRead)}/${Locale.number(request.tokens.cacheWrite)}`,
    verdict: requestVerdict(request),
    cost: request.cost === undefined ? "" : formatCost(request.cost),
  }
}

/** The columns of rows `width` cells wide for `requests`: their widest values, as far as the width allows. */
export function requestLayout(width: number, requests: readonly PacerRequest[]): RequestLayout {
  const widest = { kind: 0, model: 0, account: 0, cache: 0, verdict: 0, cost: 0 }
  const keys = Object.keys(widest) as (keyof typeof widest)[]
  for (const cells of [HEADER, ...requests.map(requestCells)])
    for (const key of keys) widest[key] = Math.max(widest[key], stringWidth(cells[key]))
  const layout = {
    width,
    kind: Math.min(widest.kind, KIND),
    model: 0,
    account: 0,
    cache: 0,
    verdict: Math.min(widest.verdict, VERDICT),
    cost: widest.cost,
  }
  const shown = () => [layout.model, layout.account, layout.cache].filter((size) => size > 0).length
  const left = () =>
    width -
    (TIME + layout.kind + layout.model + layout.account + layout.cache + layout.verdict + layout.cost) -
    GAP * (3 + shown())
  // The columns a narrow window drops, in the order they are kept, each while it fits.
  for (const [key, least] of [
    ["cache", widest.cache],
    ["account", Math.min(widest.account, ACCOUNT)],
    ["model", Math.min(widest.model, MODEL)],
  ] as const) {
    if (left() < least + GAP) break
    layout[key] = least
  }
  const grow = (key: keyof typeof widest, to: number) => {
    if (layout[key] > 0) layout[key] = Math.max(layout[key], Math.min(to, layout[key] + left()))
  }
  grow("verdict", widest.verdict)
  grow("account", widest.account)
  grow("model", widest.model)
  for (const key of Object.keys(USUAL) as (keyof typeof USUAL)[]) grow(key, USUAL[key])
  layout.verdict = Math.max(0, layout.verdict + left())
  return layout
}

/** The header over the rows, in the same columns. */
export function requestHeader(layout: RequestLayout) {
  return requestLine(layout, HEADER)
}

/** One row of the Requests tab, exactly `layout.width` cells wide (section 7). */
export function requestRow(request: PacerRequest, layout: RequestLayout) {
  return requestLine(layout, requestCells(request))
}

function requestLine(layout: RequestLayout, cells: Cells) {
  const fit = (text: string, size: number) => pad(Locale.truncateWidth(text, size), size)
  const line = [
    fit(cells.time, TIME),
    fit(cells.kind, layout.kind),
    ...(layout.model ? [fit(cells.model, layout.model)] : []),
    ...(layout.account ? [fit(cells.account, layout.account)] : []),
    ...(layout.cache ? [fit(cells.cache, layout.cache)] : []),
    fit(cells.verdict, layout.verdict),
    padStart(Locale.truncateWidth(cells.cost, layout.cost), layout.cost),
  ].join(" ".repeat(GAP))
  return fit(line, layout.width)
}

function pad(text: string, size: number) {
  return text + " ".repeat(Math.max(0, size - stringWidth(text)))
}

function padStart(text: string, size: number) {
  return " ".repeat(Math.max(0, size - stringWidth(text))) + text
}

/** What changed in a request's prompt (section 7): the lines above its items, then one line per item. */
export function promptChangeLines(change: PacerPromptChange) {
  const request = change.request
  const verdict = [request.verdict ?? (request.failed ? `failed ${request.status}` : "no verdict"), request.cause]
    .concat(request.changedPart === undefined ? [] : [`${request.changedPart} changed`])
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ")
  const cost = [
    request.rewritten === undefined ? undefined : `${Locale.number(request.rewritten)} tokens written again`,
    request.missCost === undefined ? undefined : `the miss cost ${formatCost(request.missCost)}`,
  ].filter((part): part is string => part !== undefined)
  const compared =
    change.comparedWith === undefined
      ? "compared with no earlier request"
      : `compared with ${change.comparedWith.id} of ${clockSeconds(change.comparedWith.at)}`
  const head = [
    { text: verdict, tone: request.miss ? ("warning" as const) : ("base" as const) },
    ...(cost.length ? [{ text: cost.join(" · "), tone: "muted" as const }] : []),
    { text: compared, tone: "muted" as const },
  ]
  if (change.kept === "none")
    return { head: [...head, { text: "prompt no longer kept", tone: "muted" as const }], items: [] }
  const tail = [
    change.removed.length ? `removed: ${change.removed.join(", ")}` : undefined,
    `${change.unchanged} unchanged`,
    change.kept === "part" ? "CPP kept only fingerprints of some items" : undefined,
  ].filter((part): part is string => part !== undefined)
  return {
    head,
    items: [
      ...change.items.map((item) => ({
        text: promptItemLine(item),
        tone: item.error ? ("error" as const) : ("base" as const),
      })),
      ...tail.map((text) => ({ text, tone: "muted" as const })),
    ],
  }
}

/** `changed  system  messages[0].content[0]  12.3K chars  You are…`. */
export function promptItemLine(item: PacerPromptItem) {
  return [
    item.change.padEnd(7),
    item.kind.padEnd(9),
    item.path,
    `${Locale.number(item.chars)} chars`,
    ...(item.error ? ["error"] : []),
    ...(item.summary ? [item.summary.replace(/\s+/g, " ")] : []),
  ].join("  ")
}
