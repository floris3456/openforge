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

/** 1:05:09, 23:41, 0:07: what is left of a countdown, rounded up to the second. */
export function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
  return `${minutes}:${rest}`
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

// Column widths, two spaces apart. The verdict takes what is left; a narrow window drops the model first, then the
// account, then the cache read and write, so the verdict keeps room for a miss's cause.
const TIME = 8
const KIND = 10
const ACCOUNT = 12
const CACHE = 12
const COST = 7
const GAP = 2
const VERDICT = 28
const MODEL = 18

/** The columns a row of `width` cells has room for, and the widths of the model and the verdict. */
export function requestColumns(width: number) {
  const base = width - (TIME + KIND + COST + 3 * GAP)
  const cache = base - (CACHE + GAP) >= VERDICT
  const account = cache && base - (CACHE + ACCOUNT + 2 * GAP) >= VERDICT
  const rest = base - (cache ? CACHE + GAP : 0) - (account ? ACCOUNT + GAP : 0)
  const model = account && rest - GAP - VERDICT >= 12 ? Math.min(MODEL, rest - GAP - VERDICT) : 0
  return { cache, account, model, verdict: Math.max(0, rest - (model ? model + GAP : 0)) }
}

/** The header over the rows, in the same columns. */
export function requestHeader(width: number) {
  return requestLine(width, {
    time: "time",
    kind: "kind",
    model: "model",
    account: "account",
    cache: "read/write",
    verdict: "verdict",
    cost: "cost",
  })
}

/** One row of the Requests tab, exactly `width` cells wide (section 7). */
export function requestRow(request: PacerRequest, width: number) {
  return requestLine(width, {
    time: clockSeconds(request.at),
    kind: requestKind(request),
    model: request.model,
    account: request.account ?? "–",
    cache: `${Locale.number(request.tokens.cacheRead)}/${Locale.number(request.tokens.cacheWrite)}`,
    verdict: requestVerdict(request),
    cost: request.cost === undefined ? "" : formatCost(request.cost),
  })
}

function requestLine(
  width: number,
  cells: { time: string; kind: string; model: string; account: string; cache: string; verdict: string; cost: string },
) {
  const columns = requestColumns(width)
  const fit = (text: string, size: number) => pad(Locale.truncateWidth(text, size), size)
  const line = [
    fit(cells.time, TIME),
    fit(cells.kind, KIND),
    ...(columns.model ? [fit(cells.model, columns.model)] : []),
    ...(columns.account ? [fit(cells.account, ACCOUNT)] : []),
    ...(columns.cache ? [fit(cells.cache, CACHE)] : []),
    fit(cells.verdict, columns.verdict),
    padStart(Locale.truncateWidth(cells.cost, COST), COST),
  ].join(" ".repeat(GAP))
  return fit(line, width)
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
