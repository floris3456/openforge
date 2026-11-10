import type {
  PacerAccount,
  PacerChat,
  PacerModels,
  PacerPromptChange,
  PacerPromptItem,
  PacerRequest,
  PacerWindow,
  SessionMessageCompactionWriter,
  SessionMessageInfo,
} from "@opencode/client"
import { Pacer } from "@opencode/schema/pacer"
import type { MeterTone } from "@opencode/theme/tui"
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
 * The cache item for a chat's view at `now`. In order: the account can't serve the next step; the chat was compacted
 * and nothing has been cached since (`compacted`: its newest answer is a summary; or CPP ended its pings for a
 * compaction and has started none since), so its next step writes a new cache whatever the old one did; the cache is
 * cold (and the chat compacts first, when its switch is on, its newest step announced the cold ask, as openforge's do
 * only with automatic compaction on, and it is at least as large as CPP's threshold: spec cliproxypacer-cold-ask,
 * section 3); compact before cold is due; pings stopped on a failure; warming is off; the cache is warm (with pings
 * running, it counts down to `coldAt`, which holds through the pings).
 */
export function cacheLabel(chat: PacerChat, now: number, compacted = false): CacheLabel {
  if (chat.forceUse?.when === "now")
    return { text: `account used up · next step moves to ${chat.forceUse.account}`, tone: "warning" }
  if (compacted || (chat.pings.stopped === "compacted" && !chat.pings.active))
    return { text: "compacted", tone: "muted" }
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
 * Whether a chat's newest answer, before a staged revert at `revert`, is a finished summary: it was compacted and no
 * step has run since. Covers every compaction, also one through another provider, which CPP only hears of as an event.
 */
export function endsCompacted(messages: readonly SessionMessageInfo[], revert?: string) {
  const end = revert === undefined ? -1 : messages.findIndex((message) => message.id === revert)
  const last = (end === -1 ? messages : messages.slice(0, end)).findLast(
    (message) => message.type === "assistant" || message.type === "compaction",
  )
  return last?.type === "compaction" && last.status === "completed"
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
 * What the sidebar's Usage section shows for a chat on CPP's model `model`, the one picked for it now (spec
 * cliproxypacer-usage-meters, section 1): the accounts that serve it, by provider, then alias, and the chat's view when
 * it is of that model (as named, or pinned as `<provider>/<model>`), whose account and moves are marked.
 *
 * The providers are the one of the account serving the chat, while the view is of the model and that provider serves
 * it, plus those its moves go to; else those serving the model. CPP keeps a chat's account until a step of the new
 * model is routed. Of a provider only some of whose accounts serve the model (`PacerModel.partial`), only the accounts
 * CPP names for the chat: CPP doesn't say which of the others do.
 */
export function usageAccounts(input: {
  readonly accounts: readonly PacerAccount[]
  readonly model: string
  readonly chat: PacerChat | undefined
  readonly models: PacerModels | undefined
}) {
  const model = input.model.toLowerCase()
  const chat = input.chat
  const serving = chatAccount(input.accounts, chat)
  const entry = input.models?.items.find((item) => item.id.toLowerCase() === model)
  const servedBy = (entry?.providers ?? []).map((item) => item.toLowerCase())
  const partial = new Set((entry?.partial ?? []).map((item) => item.toLowerCase()))
  const provider = (serving?.provider ?? chat?.provider)?.toLowerCase()
  const forModel =
    chat?.model !== undefined && [chat.model, `${provider}/${chat.model}`].some((name) => name.toLowerCase() === model)
  const own = serving?.provider.toLowerCase()
  const current = forModel && own !== undefined && (servedBy.length === 0 || servedBy.includes(own))
  const moves = forModel ? [chat?.nextUse?.account, chat?.forceUse?.account] : []
  const providers = new Set([
    ...(current ? [own] : servedBy),
    ...input.accounts.filter((item) => moves.includes(item.alias)).map((item) => item.provider.toLowerCase()),
  ])
  const named = (account: PacerAccount) =>
    (forModel && serving !== undefined && sameAccount(serving, account)) || moves.includes(account.alias)
  return {
    accounts: input.accounts
      .filter((account) => {
        const name = account.provider.toLowerCase()
        return providers.has(name) && (!partial.has(name) || named(account))
      })
      .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.alias.localeCompare(b.alias)),
    chat: forModel ? chat : undefined,
  }
}

/** Whether `account` is `other`: by CPP's ID, or by alias from a service that sends none. */
function sameAccount(other: PacerAccount, account: PacerAccount) {
  return other.id !== undefined ? other.id === account.id : other.alias === account.alias
}

/** The model families whose windows limit a model whose name holds the family's word (CPP's `Window::applies`). */
const FAMILIES = ["opus", "sonnet", "haiku", "spark", "fable"]

/**
 * CPP's model groups (`antigravity_group`): a group's windows limit the models whose names hold one of its markers, the
 * first group that matches. An account's windows of every group show, a block each, in this order (section 2).
 */
const MODEL_GROUPS = [
  { scope: "claude_gpt", name: "Claude & GPT", markers: ["claude", "gpt", "opus", "sonnet", "haiku", "oss"] },
  { scope: "gemini", name: "Gemini", markers: ["gemini"] },
] as const

/**
 * Whether a window limits requests for `model`, as CPP's `Window::applies` decides (spec, section 1): `all` and `oauth`
 * every model; a family a model whose name holds it; a model group's scope the models of that group; `model:<name>`
 * that model, also pinned as `<provider>/<name>`; any other scope none.
 */
export function windowApplies(window: Pick<PacerWindow, "scope">, model: string) {
  const name = model.toLowerCase()
  const scope = window.scope.toLowerCase()
  if (scope === "all" || scope === "oauth") return true
  if (FAMILIES.includes(scope)) return name.includes(scope)
  if (isModelGroup(scope)) return modelGroup(name) === scope
  if (!scope.startsWith("model:")) return false
  const wanted = scope.slice("model:".length)
  return name === wanted || name.slice(name.indexOf("/") + 1) === wanted
}

/** The model group whose windows a model counts against, if any. */
function modelGroup(model: string) {
  const name = model.toLowerCase()
  return MODEL_GROUPS.find((group) => group.markers.some((marker) => name.includes(marker)))?.scope
}

function isModelGroup(scope: string) {
  return MODEL_GROUPS.some((group) => group.scope === scope)
}

const PROVIDERS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
}

/**
 * CPP's names of its plan IDs, as its pages give them (`ui/src/core.ts` `planName`, CPP `1bc19d1e`), in its order: the
 * order of the groups of one provider.
 */
const PLANS: Record<string, string> = {
  default_claude_max_20x: "Ultra",
  default_claude_max_5x: "Max 5x",
  default_claude_pro: "Pro",
  claude_pro: "Pro",
  claude_max: "Max",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  "g1-pro-tier": "Pro",
  "g1-ultra-tier": "Ultra",
  "free-tier": "Free",
  "standard-tier": "Standard",
  "legacy-tier": "Legacy",
  edu: "Edu",
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-max": "Max",
  "individual-provider": "Provider",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
}
const PLAN_ORDER = Object.keys(PLANS)

/** A group's name (section 2): the provider's, then its plan's (`Claude Ultra`, `Antigravity Google AI Pro`). */
export function usageGroupName(account: Pick<PacerAccount, "provider" | "plan" | "planName">) {
  const provider = PROVIDERS[account.provider.toLowerCase()] ?? account.provider
  const plan = usagePlanName(account)
  return plan ? `${provider} ${plan}` : provider
}

/**
 * The plan in a group's name (section 2): the provider's own name of it (CPP's `plan_name`); else CPP's name of its ID;
 * else the ID without a leading `default_` or `claude_` and a trailing `-tier`, `_` and `-` as spaces, each word
 * capitalized. None for `default_claude_ai` and, for Claude, a free plan (Claude Code needs Pro or Max).
 */
export function usagePlanName(account: Pick<PacerAccount, "provider" | "plan" | "planName">) {
  const name = account.planName?.trim() || planIDName(account.plan?.trim() ?? "")
  if (/^(claude|anthropic)$/i.test(account.provider) && /^free\b/i.test(name)) return ""
  return name
}

function planIDName(plan: string) {
  if (plan === "" || plan.toLowerCase() === "default_claude_ai") return ""
  const known = PLANS[plan.toLowerCase()]
  if (known) return known
  const words = plan
    .replace(/^default_/i, "")
    .replace(/^claude_/i, "")
    .replace(/-tier$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
  return (words || plan).replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
}

/** A window's length in its largest whole unit: 18000 s → `5h`, 604800 s → `7d`, 2592000 s → `30d`. */
export function windowLength(seconds: number) {
  const unit = (
    [
      [86_400, "d"],
      [3_600, "h"],
      [60, "m"],
    ] as const
  ).find(([size]) => seconds >= size && seconds % size === 0)
  return unit ? `${seconds / unit[0]}${unit[1]}` : `${seconds}s`
}

/**
 * The time to a reset (section 3): `<1m`; minutes, rounded up, under an hour; then hours, then days, rounded down. With
 * `two`, the next unit after the first unless it is 0: `47m`, `2h 10m`, `2h`, `6d 23h`, `7d`; else one: `2h`, `6d`.
 */
export function usageCountdown(ms: number, two = false) {
  if (ms < 60_000) return "<1m"
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return two && minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return two && hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** The theme's text color of a part of a line: its role. */
export type UsageInk = "base" | "muted" | "faint" | "success" | "info" | "warning" | "error"

/** A part of a line of the Usage section: its text in one color, on the sidebar's background or a meter's tone. */
export interface UsageSpan {
  readonly text: string
  readonly ink: UsageInk
  readonly bold?: boolean
  /** Dimmed: everything is while CPP is unreachable. */
  readonly dim?: boolean
  /** Its cells' background, a tone of the theme's `background.meter`; the sidebar's own without one. */
  readonly background?: MeterTone
  /** The tone of every other account's row (`background.meter.alternate`). */
  readonly alternate?: boolean
}

/** A cell of a line; a wide character's second cell has no text. */
interface Cell {
  readonly text: string
  readonly ink: UsageInk
  readonly bold?: boolean
  readonly background?: MeterTone
  readonly alternate?: boolean
}

const TITLE = "Usage"
/** A row's first cells, for its marks. */
const GUTTER = 2
/** Between two strips. */
const STRIP_GAP = 1
/** The narrowest strip a line keeps, and the most strips on a line. */
const STRIP = 11
const PER_LINE = 3
/** The narrowest strip that gives a time in two units. */
const TWO_UNITS = 15

type Mark = "in use" | "last used" | "next" | "forced"
const MARKS: Record<Mark, { readonly text: string; readonly ink: UsageInk }> = {
  "in use": { text: "●", ink: "success" },
  "last used": { text: "●", ink: "info" },
  next: { text: "›", ink: "info" },
  forced: { text: "»", ink: "warning" },
}

/**
 * The strips of a group whose blocks have at most `count` windows, on lines `width` wide (section 3): as many on a line
 * as keep them {@link STRIP} cells wide, at most three; two 17 cells wide and three 11 at 37, and one as wide as two.
 */
export function usageStrips(width: number, count: number) {
  const size = (n: number) => Math.floor((width - GUTTER - STRIP_GAP * (n - 1)) / n)
  const perLine = [PER_LINE, 2].find((n) => n <= count && size(n) >= STRIP) ?? 1
  return { perLine, width: perLine > 1 || size(2) >= STRIP ? size(Math.max(2, perLine)) : size(1) }
}

/**
 * The sidebar's Usage section (spec cliproxypacer-usage-meters, sections 2 to 4), each line exactly `width` cells: the
 * title, with the legend of the marks shown at its right end (on a line of its own under the groups when it doesn't
 * fit), `as of` while CPP is unreachable, or `no pacer` alone on a proxy without the pacer; then one group per provider
 * and plan, its windows' labels over their strips, one row per account without its name, each window that limits
 * `model` (and every window of a model group) a strip. `chat` is `usageAccounts`' view: the marks show only while it is
 * of the model. With `asOf`, every line is faint and dimmed, the fills muted and the times as of then.
 */
export function usageSection(input: {
  readonly accounts: readonly PacerAccount[]
  readonly model: string
  readonly serving: PacerAccount | undefined
  readonly chat: PacerChat | undefined
  readonly running: boolean
  readonly width: number
  readonly now: number
  readonly asOf?: number
  readonly noPacer?: boolean
}): UsageSpan[][] {
  const greyed = input.asOf !== undefined
  const title = (right: Cell[]) => titleLine(input.width, greyed, right)
  if (input.noPacer) return [spans(title(textCells("no pacer", "muted")), false)]
  const shown = new Set<Mark>()
  const marks = (account: PacerAccount): Mark[] => {
    const chat = input.chat
    if (chat === undefined) return []
    const identity: Mark[] =
      input.serving !== undefined && sameAccount(input.serving, account) ? [input.running ? "in use" : "last used"] : []
    const own: Mark[] =
      chat.forceUse?.account === account.alias
        ? [...identity, "forced"]
        : chat.nextUse?.account === account.alias
          ? [...identity, "next"]
          : identity
    for (const mark of own) shown.add(mark)
    return own
  }
  const body = Array.from(Map.groupBy(input.accounts, (account) => groupKey(account)).values())
    .toSorted(
      (a, b) =>
        a[0]!.provider.toLowerCase().localeCompare(b[0]!.provider.toLowerCase()) ||
        Number(usagePlanName(a[0]!) === "") - Number(usagePlanName(b[0]!) === "") ||
        planRank(a) - planRank(b) ||
        usageGroupName(a[0]!).localeCompare(usageGroupName(b[0]!)),
    )
    .flatMap((group) =>
      groupLines(
        group.toSorted((a, b) => a.alias.localeCompare(b.alias) || (a.id ?? "").localeCompare(b.id ?? "")),
        marks,
        { model: input.model, width: input.width, now: input.now, greyed },
      ),
    )
  if (input.asOf !== undefined)
    return [title(textCells(`as of ${clockTime(input.asOf)}`, "faint")), ...body].map((line) => spans(line, true))
  const legend = (["in use", "last used", "next", "forced"] as const)
    .filter((mark) => shown.has(mark))
    .flatMap((mark, index) => [
      ...(index > 0 ? blank(2) : []),
      { text: MARKS[mark].text, ink: MARKS[mark].ink },
      ...textCells(` ${mark}`, "muted"),
    ])
  const beside = TITLE.length + 1 + legend.length <= input.width
  const lines = beside ? [title(legend), ...body] : [title([]), ...body, fit(legend, input.width)]
  return lines.map((line) => spans(line, false))
}

/** A group's accounts: one provider's of one plan, as its name says. */
function groupKey(account: PacerAccount) {
  return `${account.provider.toLowerCase()}\n${usagePlanName(account).toLowerCase()}`
}

/** Where a group's plan comes in CPP's order of its plans; after them, plans of IDs it doesn't name. */
function planRank(group: readonly PacerAccount[]) {
  return Math.min(
    ...group.map((account) => {
      const index = PLAN_ORDER.indexOf(account.plan?.trim().toLowerCase() ?? "")
      return index < 0 ? PLAN_ORDER.length : index
    }),
  )
}

/**
 * A group's lines (section 2): its name, with its labels when they leave it room; then its rows. A group with model
 * groups has its name on a line of its own, then a block per model group, each with its name and labels over its rows:
 * the accounts in one order in every block, the marks in the block of the model's group (the first for none).
 */
function groupLines(
  accounts: readonly PacerAccount[],
  marks: (account: PacerAccount) => Mark[],
  input: { readonly model: string; readonly width: number; readonly now: number; readonly greyed: boolean },
) {
  const held = (account: PacerAccount) =>
    account.windows.filter((window) => isModelGroup(window.scope) || windowApplies(window, input.model))
  const all = accounts.flatMap(held)
  const grouped = all.some((window) => isModelGroup(window.scope))
  const blocks = [
    { name: undefined, scope: undefined, columns: columnsOf(all.filter((window) => !isModelGroup(window.scope))) },
    ...MODEL_GROUPS.map((group) => ({
      name: group.name as string,
      scope: group.scope as string,
      columns: columnsOf(all.filter((window) => window.scope === group.scope)),
    })),
  ].filter((block, index) => block.columns.length > 0 || (index === 0 && !grouped))
  const marked = Math.max(
    0,
    blocks.findIndex((block) => block.scope !== undefined && block.scope === modelGroup(input.model)),
  )
  const strips = usageStrips(input.width, Math.max(...blocks.map((block) => block.columns.length)))
  const name = textCells(
    Locale.truncateWidth(usageGroupName(accounts[0]!), input.width),
    input.greyed ? "faint" : "base",
    !input.greyed,
  )
  const rows = accounts.map((account, index) => ({
    windows: held(account),
    marks: marks(account),
    alternate: index % 2 === 1,
  }))
  // A model group's block names its scope; the other windows' scope goes unsaid only when every column shares it.
  const columns = blocks.flatMap((block) => block.columns)
  const shared = columns.every((column) => column.scope === columns[0]?.scope) ? columns[0]?.scope : undefined
  const block = (item: (typeof blocks)[number], index: number) => {
    const head =
      item.name === undefined ? (grouped ? undefined : name) : textCells(item.name, input.greyed ? "faint" : "base")
    const labels = labelLines(item.columns, item.scope ?? shared, strips, input)
    return [
      ...withName(head, labels, input.width),
      ...rows.flatMap((row) =>
        rowLines({ ...row, marks: index === marked ? row.marks : [] }, item.columns, strips, input),
      ),
    ]
  }
  return [...(grouped ? [fit(name, input.width)] : []), ...blocks.flatMap(block)]
}

/** The windows of a group, once each: `all` first, then the other scopes alphabetically, each by length. */
function columnsOf(windows: readonly PacerWindow[]) {
  return Array.from(new Map(windows.map((window) => [`${window.scope}\n${window.seconds}`, window])).values()).toSorted(
    (a, b) =>
      Number(a.scope !== "all") - Number(b.scope !== "all") || a.scope.localeCompare(b.scope) || a.seconds - b.seconds,
  )
}

/**
 * The label lines of a block, each label at its strip's end, over the time, without the scope `shared` (the block's
 * model group, or every column's); and where the first label starts.
 */
function labelLines(
  columns: readonly PacerWindow[],
  shared: string | undefined,
  strips: ReturnType<typeof usageStrips>,
  input: { readonly width: number; readonly greyed: boolean },
) {
  const labels = columns.map((column) => columnLabel(column, shared, strips.width - 1))
  const lines = chunk(labels, strips.perLine).map((chunk) =>
    chunk.reduce((line, label, index) => {
      const end = GUTTER + (index + 1) * strips.width + index * STRIP_GAP - 1
      return place(line, end - label.length, textCells(label, input.greyed ? "faint" : "muted"))
    }, blank(input.width)),
  )
  return { lines, start: GUTTER + strips.width - 1 - (labels[0]?.length ?? 0) }
}

/** A column's label: its length after its scope, unless that is `all` or every column's; the scope cut to fit. */
function columnLabel(window: PacerWindow, shared: string | undefined, room: number) {
  const length = windowLength(window.seconds)
  if (window.scope === "all" || window.scope === shared) return length
  const label = `${window.scope} ${length}`
  if (label.length <= room) return label
  const left = room - length.length - 1
  return left >= 2 ? `${Locale.truncateWidth(window.scope, left)} ${length}` : length
}

/** A name on its labels' first line when it ends a cell before the first label; else on a line of its own above. */
function withName(name: Cell[] | undefined, labels: ReturnType<typeof labelLines>, width: number) {
  if (name === undefined) return labels.lines
  if (labels.lines.length === 0 || name.length + 1 > labels.start) return [fit(name, width), ...labels.lines]
  return [place(labels.lines[0]!, 0, name), ...labels.lines.slice(1)]
}

/**
 * An account's lines in a block (section 2): its marks, then a strip per column, one cell apart, up to a line's strips
 * on each line; `no reading yet` for an account with no window shown at all.
 */
function rowLines(
  row: { readonly windows: readonly PacerWindow[]; readonly marks: readonly Mark[]; readonly alternate: boolean },
  columns: readonly PacerWindow[],
  strips: ReturnType<typeof usageStrips>,
  input: { readonly width: number; readonly now: number; readonly greyed: boolean },
) {
  const gutter = [
    ...row.marks.slice(0, GUTTER).map((mark) => ({
      text: MARKS[mark].text,
      ink: input.greyed ? ("faint" as const) : MARKS[mark].ink,
      bold: true,
    })),
    ...blank(Math.max(0, GUTTER - row.marks.length)),
  ]
  if (row.windows.length === 0)
    return [fit([...gutter, ...textCells("no reading yet", input.greyed ? "faint" : "muted")], input.width)]
  return chunk(columns, strips.perLine).map((line, index) =>
    fit(
      [
        ...(index === 0 ? gutter : blank(GUTTER)),
        ...line.flatMap((column, at) => [
          ...(at > 0 ? blank(STRIP_GAP) : []),
          ...strip(
            row.windows.find((window) => window.scope === column.scope && window.seconds === column.seconds),
            { width: strips.width, alternate: row.alternate, now: input.now, greyed: input.greyed },
          ),
        ]),
      ],
      input.width,
    ),
  )
}

/**
 * One window as a strip (section 3): its fill what is left, in the tone of how much (muted when the reading isn't
 * current); the percent left at its start, bold, after a cell; the time to its reset at its end, a cell before it. An
 * empty track with a faint `–` in its middle where the account has no such window.
 */
function strip(
  window: PacerWindow | undefined,
  input: { readonly width: number; readonly alternate: boolean; readonly now: number; readonly greyed: boolean },
): Cell[] {
  const alternate = input.alternate ? { alternate: true } : {}
  if (window === undefined)
    return Array.from(
      { length: input.width },
      (_, index): Cell => ({
        text: index === Math.floor(input.width / 2) ? "–" : " ",
        ink: index === Math.floor(input.width / 2) ? "faint" : "base",
        background: "track",
        ...alternate,
      }),
    )
  const left = window.left === undefined ? undefined : Math.max(0, Math.min(100, window.left))
  const passed =
    window.state === "awaiting-confirmation" || (window.resetsAt !== undefined && window.resetsAt <= input.now)
  const current = left !== undefined && !passed && !windowStale(window, input.now)
  const tone = ((): MeterTone => {
    if (input.greyed || !current) return "muted"
    if (left <= 10) return "error"
    if (left <= 20) return "warning"
    return "success"
  })()
  const filled = left === undefined ? 0 : left >= 100 ? input.width : Math.round((left / 100) * input.width)
  const percent = left === undefined ? "?" : left > 0 && left < 1 ? "<1%" : `${Math.floor(left)}%`
  const percentInk = ((): UsageInk => {
    if (input.greyed) return "faint"
    if (left === undefined) return "muted"
    if (tone === "warning" || tone === "error") return tone
    return "base"
  })()
  const time = (() => {
    if (window.state === "dormant") return "idle"
    if (passed) return "now"
    if (window.resetsAt === undefined) return ""
    return `${window.state === "estimated" ? "~" : ""}${usageCountdown(window.resetsAt - input.now, input.width >= TWO_UNITS)}`
  })()
  const inner = input.width - 2
  const tail = percent.length + 1 + time.length <= inner ? time : ""
  const text = ` ${(percent + " ".repeat(Math.max(0, inner - percent.length - tail.length)) + tail).slice(0, inner)} `
  return Array.from(
    text,
    (character, index): Cell => ({
      text: character,
      ...(index === 0 || index === input.width - 1
        ? { ink: "base" as const }
        : index <= percent.length
          ? { ink: percentInk, ...(input.greyed || left === undefined ? {} : { bold: true }) }
          : { ink: input.greyed ? ("faint" as const) : ("base" as const) }),
      background: index < filled ? tone : "track",
      ...alternate,
    }),
  )
}

/** The title line: `Usage` in bold, and `right` at its right end. */
function titleLine(width: number, greyed: boolean, right: Cell[]) {
  const tail = right.slice(0, Math.max(0, width - TITLE.length - 1))
  return fit(
    [...textCells(TITLE, greyed ? "faint" : "base", true), ...blank(width - TITLE.length - tail.length), ...tail],
    width,
  )
}

const graphemes = new Intl.Segmenter()

/** `text` as cells: a wide character takes two, the second without text. */
function textCells(text: string, ink: UsageInk, bold = false): Cell[] {
  return Array.from(graphemes.segment(text), (part) => part.segment).flatMap((grapheme) => {
    const cell = { text: grapheme, ink, ...(bold ? { bold } : {}) }
    return stringWidth(grapheme) > 1 ? [cell, { ...cell, text: "" }] : [cell]
  })
}

function blank(count: number): Cell[] {
  return Array.from({ length: Math.max(0, count) }, () => ({ text: " ", ink: "base" }))
}

/** `cells` at `start` of `line`, over what was there. */
function place(line: readonly Cell[], start: number, cells: readonly Cell[]) {
  return [...line.slice(0, start), ...cells, ...line.slice(start + cells.length)]
}

/** A line exactly `width` cells: padded, or cut. */
function fit(cells: readonly Cell[], width: number) {
  return [...cells.slice(0, width), ...blank(width - cells.length)]
}

function chunk<Item>(items: readonly Item[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

/** A line's cells as spans: each run of cells drawn alike. */
function spans(cells: readonly Cell[], dim: boolean): UsageSpan[] {
  const key = (cell: Cell) => `${cell.ink}/${cell.bold === true}/${cell.background ?? ""}/${cell.alternate === true}`
  return cells
    .reduce<{ key: string; cell: Cell; text: string }[]>((runs, cell) => {
      const last = runs.at(-1)
      if (last && last.key === key(cell)) {
        last.text += cell.text
        return runs
      }
      runs.push({ key: key(cell), cell, text: cell.text })
      return runs
    }, [])
    .map((run) => ({
      text: run.text,
      ink: run.cell.ink,
      ...(run.cell.bold ? { bold: true } : {}),
      ...(dim ? { dim: true } : {}),
      ...(run.cell.background === undefined
        ? {}
        : { background: run.cell.background, ...(run.cell.alternate ? { alternate: true } : {}) }),
    }))
}

/** A line as text, as the screen shows it. */
export function usageText(line: readonly UsageSpan[]) {
  return line.map((span) => span.text).join("")
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

/**
 * openforge (spec row-help): a request row's help, `?` in the Requests tab: every column of the row in full, which a
 * narrow window drops or cuts, then what a row is and what its keys do.
 */
export function requestHelp(request: PacerRequest) {
  const cells = requestCells(request)
  return [
    [
      `${cells.time} · ${cells.kind} · ${cells.model}`,
      `Account: ${cells.account}`,
      `Read from / written to the cache: ${cells.cache} tokens`,
      `Verdict: ${cells.verdict || "none yet"}`,
      ...(cells.cost ? [`Cost: ${cells.cost}`] : []),
    ].join("\n"),
    "Each row is one request this chat or one of its subagents sent through CLIProxyPacer, newest first. Read/write is how many prompt tokens the provider read from its cache and wrote to it. The verdict says whether the cache was reused, partly reused or missed, and for a miss what caused it.",
    "A narrow window drops the model, account and read/write columns and cuts long values; this help shows them in full. Enter moves the chat to where the request ended; Ctrl+Enter shows what changed in its prompt. The records come from CLIProxyPacer and show only while it answers.",
  ].join("\n\n")
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
