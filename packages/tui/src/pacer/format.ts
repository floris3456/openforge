import type {
  PacerAccount,
  PacerChat,
  PacerModels,
  PacerPromptChange,
  PacerPromptItem,
  PacerRequest,
  PacerWindow,
  SessionMessageCompactionWriter,
} from "@opencode/client"
import { Pacer } from "@opencode/schema/pacer"
import { Locale } from "../util/locale"
import { stringWidth } from "../util/string-width"

// The words and numbers CLIProxyPacer's screens print (spec cliproxypacer-step-1, sections 4 and 7, and the usage
// meters of spec cliproxypacer-usage-meters), as pure functions of openforge's own shapes and the time, so every row of
// the specs is one unit test.

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
 * The toolbar's cache item (section 4). With `until`, it counts down to it: the item prints what is left after `text`,
 * padded, so that its width and its form hold while it counts.
 */
export interface CacheLabel {
  readonly text: string
  readonly tone: "muted" | "warning"
  readonly until?: number
}

/**
 * The cache item for a chat's view at `now`. In order: the account can't serve the next step; the cache is cold (and
 * the chat compacts first, when its switch is on, its newest step announced the cold ask, as openforge's do only with
 * automatic compaction on, and it is at least as large as CPP's threshold: spec cliproxypacer-cold-ask, section 3);
 * compact before cold is due; pings stopped on a failure; warming is off; the cache is warm (with pings running, it
 * counts down to `coldAt`, which holds through the pings).
 */
export function cacheLabel(chat: PacerChat, now: number): CacheLabel {
  if (chat.forceUse?.when === "now")
    return { text: `account used up · next step moves to ${chat.forceUse.account}`, tone: "warning" }
  const until = chat.coldAt ?? chat.warmUntil
  if (!chat.warm || (until !== undefined && until <= now)) {
    const first =
      chat.switches.compactColdFirst &&
      chat.coldAskAnnounced === true &&
      chat.size !== undefined &&
      chat.size.tokens >= chat.size.threshold
    return { text: first ? "cache cold · compacts first" : "cache cold", tone: "warning" }
  }
  if (chat.switches.compactBeforeCold && chat.compactAt !== undefined && chat.compactReason !== "cold")
    return { text: `compacts at ${clockTime(chat.compactAt)}`, tone: "muted" }
  if (until === undefined) return { text: "warm", tone: "muted" }
  if (chat.pings.failed) return { text: "keep-alive stopped · warm ", tone: "warning", until }
  if (!chat.switches.warming) return { text: "warming off · warm ", tone: "muted", until }
  return { text: "warm ", tone: "muted", until }
}

/**
 * The compaction divider's words for a summary whose writer is known (spec cliproxypacer-server-summaries, section 3),
 * at most `width` cells: `Compaction · by CLIProxyPacer on <model> · cold · 12 of your messages kept · <usage>`, or
 * `Compaction · by openforge · CLIProxyPacer couldn't: <reason> · <usage>`, each part only when known. When it doesn't
 * fit, the optional parts go in this order: the usage, the messages kept, the model, `cold`. The reason, the only free
 * text, is cut first and goes once not one character of it fits. What is left of the head is cut last.
 */
export function compactionLine(
  compaction: { writer: SessionMessageCompactionWriter; model?: string; usage?: string },
  width: number,
) {
  const writer = compaction.writer
  const head = `Compaction · by ${writer.by === "cliproxypacer" ? "CLIProxyPacer" : "openforge"}`
  const fallback = writer.fallback?.replace(/\s+/g, " ").trim()
  // In the order they show, each with its rank: the lowest goes first.
  const known: { text: string | false | undefined; rank: number; cut?: boolean }[] =
    writer.by === "cliproxypacer"
      ? [
          { text: compaction.model && ` on ${compaction.model}`, rank: 2 },
          { text: writer.cold && " · cold", rank: 3 },
          { text: writer.userMessages !== undefined && ` · ${writer.userMessages} of your messages kept`, rank: 1 },
          { text: compaction.usage && ` · ${compaction.usage}`, rank: 0 },
        ]
      : [
          { text: fallback && ` · CLIProxyPacer couldn't: ${fallback}`, rank: 1, cut: true },
          { text: compaction.usage && ` · ${compaction.usage}`, rank: 0 },
        ]
  const parts = known.flatMap((part) =>
    part.text ? [{ text: part.text, rank: part.rank, cut: part.cut === true }] : [],
  )
  const line = () => head + parts.map((part) => part.text).join("")
  while (parts.length > 0 && stringWidth(line()) > width) {
    const lowest = parts.reduce((low, part) => (part.rank < low.rank ? part : low))
    const room = width - (stringWidth(line()) - stringWidth(lowest.text))
    const prefix = " · CLIProxyPacer couldn't: "
    if (lowest.cut && room - stringWidth(prefix) >= 2) {
      lowest.text = prefix + Locale.truncateWidth(fallback!, room - stringWidth(prefix))
      break
    }
    parts.splice(parts.indexOf(lowest), 1)
  }
  return Locale.truncateWidth(line(), width)
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
 * The account serving the chat, or the one that served it last. By its ID: CPP names two logins of one address alike,
 * each with its own readings. By alias only from a service that sends no ID.
 */
export function chatAccount(accounts: readonly PacerAccount[], chat: PacerChat | undefined) {
  if (chat?.account === undefined) return undefined
  if (chat.accountID !== undefined && accounts.some((item) => item.id !== undefined))
    return accounts.find((item) => item.id === chat.accountID)
  return accounts.find((item) => item.alias === chat.account)
}

/**
 * The accounts whose meters the sidebar shows for a chat on CPP's model `model` (spec cliproxypacer-usage-meters,
 * section 1), by provider, then alias: every account of the provider of the account serving the chat, while its view
 * is of that model (as named, or pinned as `<provider>/<model>`) and that account has meters; else of the providers
 * whose logins serve the model.
 */
export function usageAccounts(input: {
  readonly accounts: readonly PacerAccount[]
  readonly model: string
  readonly chat: PacerChat | undefined
  readonly models: PacerModels | undefined
}) {
  const model = input.model.toLowerCase()
  const serving = chatAccount(input.accounts, input.chat)
  const named = input.chat?.model && [input.chat.model, `${serving?.provider}/${input.chat.model}`]
  const providers = new Set(
    (serving && named && named.some((name) => name.toLowerCase() === model)
      ? [serving.provider]
      : (input.models?.items.find((item) => item.id.toLowerCase() === model)?.providers ?? [])
    ).map((provider) => provider.toLowerCase()),
  )
  return input.accounts
    .filter((account) => providers.has(account.provider.toLowerCase()))
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.alias.localeCompare(b.alias))
}

/** A tag on an account's head, in OpenCodePlus's words and colors. */
export interface UsageTag {
  readonly text: "IN USE" | "LAST USED" | "NEXT USE" | "FORCE USE"
  readonly tone: "success" | "info" | "warning"
}

/**
 * The tags on an account's head (section 2): `IN USE` while the chat's step runs on it, else `LAST USED` for the
 * account that served it last; `FORCE USE` where a forced move sends the chat, else `NEXT USE` where it goes once its
 * cache is cold. CPP names those two by alias.
 */
export function usageTags(input: {
  readonly account: PacerAccount
  readonly serving: PacerAccount | undefined
  readonly chat: PacerChat | undefined
  readonly running: boolean
}): UsageTag[] {
  const account = input.account
  const serving = input.serving
  const own =
    serving !== undefined && (serving.id !== undefined ? serving.id === account.id : serving.alias === account.alias)
  const identity: UsageTag[] = own
    ? [input.running ? { text: "IN USE", tone: "success" } : { text: "LAST USED", tone: "info" }]
    : []
  if (input.chat?.forceUse?.account === account.alias) return [...identity, { text: "FORCE USE", tone: "warning" }]
  if (input.chat?.nextUse?.account === account.alias) return [...identity, { text: "NEXT USE", tone: "info" }]
  return identity
}

/** How a meter's bar is colored: by what is left while the reading is current, else muted. */
export type UsageTone = "normal" | "low" | "critical" | "muted"

/** One meter of an account (section 3): its parts in order, each padded to its column, one space apart. */
export interface UsageMeter {
  readonly label: string
  readonly filled: string
  readonly empty: string
  readonly percent: string
  readonly tail: string
  readonly tone: UsageTone
}

/** The label column of an account's meters: its longest label, from 2 to 18 cells. */
export function usageLabelWidth(windows: readonly PacerWindow[]) {
  return Math.min(18, Math.max(2, ...windows.map((window) => stringWidth(window.label))))
}

/**
 * A meter `width` cells wide, less one, at `now`, as OpenCodePlus draws it: the label; a bar of `█` and `░` taking what
 * is left, at least 4 cells; the percent left, rounded down (`<1%` for a sliver); then, in 7 cells, the time to the
 * reset (`~` in front of CPP's estimate), or `reset`, `dormant`, `STALE`, or `unknown` with a bar of `·` when the
 * balance is unknown.
 */
export function usageMeter(window: PacerWindow, labelWidth: number, width: number, now: number): UsageMeter {
  const cells = Math.max(4, width - labelWidth - 15)
  const left = window.left === undefined ? undefined : Math.max(0, Math.min(100, window.left))
  const filled = left === undefined ? 0 : Math.min(cells, Math.round((left / 100) * cells))
  const state = (() => {
    if (window.state === "dormant") return { tail: "dormant", current: false }
    if (window.state === "awaiting-confirmation" || (window.resetsAt !== undefined && window.resetsAt <= now))
      return { tail: "reset", current: false }
    if (left === undefined) return { tail: "unknown", current: false }
    if (windowStale(window, now)) return { tail: "STALE", current: false }
    if (window.resetsAt === undefined) return { tail: "", current: true }
    return {
      tail: `${window.state === "estimated" ? "~" : ""}${usageCountdown(window.resetsAt - now)}`,
      current: true,
    }
  })()
  const tone = ((): UsageTone => {
    if (!state.current || left === undefined) return "muted"
    if (left <= 10) return "critical"
    if (left <= 20) return "low"
    return "normal"
  })()
  return {
    label: pad(Locale.truncateWidth(window.label, labelWidth), labelWidth),
    filled: left === undefined ? "·".repeat(cells) : "█".repeat(filled),
    empty: left === undefined ? "" : "░".repeat(cells - filled),
    percent: padStart(left === undefined ? "" : left > 0 && left < 1 ? "<1%" : `${Math.floor(left)}%`, 4),
    tail: padStart(state.tail, 7),
    tone,
  }
}

/** A meter as one line. */
export function usageLine(meter: UsageMeter) {
  return `${meter.label} ${meter.filled}${meter.empty} ${meter.percent} ${meter.tail}`
}

/** The time to a reset, with two units so it never reads as a window's length: `6d 23h`, `5h 0m`, `59m`, `<1m`. */
export function usageCountdown(ms: number) {
  if (ms < 60_000) return "<1m"
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
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
  // One wording with the cache notices, which the service builds.
  return [request.verdict, Pacer.causeText(request)].filter((part) => part !== "").join(" · ")
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
    change.kept === "part" ? "CLIProxyPacer kept only fingerprints of some items" : undefined,
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

/**
 * What changed for a request that goes by its row (`Pacer.promptless`; spec cliproxypacer-step-2, section 4): a web
 * tool call, or any other request CPP recorded without a request ID. It sent no prompt, so nothing is read.
 */
export function promptlessLines(request: Pick<PacerRequest, "kind"> | undefined) {
  const text =
    request?.kind === "search"
      ? "A web tool call sends no prompt, so there is nothing to compare"
      : "CLIProxyPacer recorded this request without a request ID, so it keeps no prompt to compare"
  return { head: [{ text, tone: "muted" as const }], items: [] }
}

// Cache notices (spec cliproxypacer-cache-notices, section 3): OpenCodePlus's cards, their texts and their stacking.

/** 152K, 18.4K, 1.2M: tokens as a card counts them. */
export function formatTokens(tokens: number) {
  const value = Math.round(tokens)
  if (value < 1_000) return String(value)
  if (value < 999_500) return `${trimTokens(value / 1_000)}K`
  return `${trimTokens(value / 1_000_000)}M`
}

function trimTokens(value: number) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
}

/** A card's first line: `Cache miss · 152K tokens not reused`, or without a count when the row has none. */
export function noticeTitle(notice: { readonly verdict: "miss" | "partial"; readonly tokens?: number }) {
  const kind = notice.verdict === "miss" ? "Cache miss" : "Partial cache reuse"
  return notice.tokens === undefined ? kind : `${kind} · ${formatTokens(notice.tokens)} tokens not reused`
}

/** A card's age at `now`: `just now`, then `3 min ago`. */
export function noticeAge(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  return minutes === 0 ? "just now" : `${minutes} min ago`
}

/** A card's second line: the chat's title (its ID without one), agent and model. */
export function noticeSubject(notice: {
  readonly sessionID: string
  readonly title?: string
  readonly agent?: string
  readonly model?: string
}) {
  return [notice.title || notice.sessionID, notice.agent, notice.model].filter(Boolean).join(" · ")
}

/** The cards a stack shows in a terminal `height` rows high, four rows each: at most 4, at least 1. */
export function noticesShown(height: number) {
  return Math.max(1, Math.min(4, Math.floor((height - 8) / 4)))
}

/** The line under the cards for those beyond them. */
export function noticesMore(count: number, shown: number) {
  return count > shown ? `+${count - shown} more cache notices` : undefined
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
