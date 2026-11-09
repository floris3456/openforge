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
 * Whether a window limits requests for `model`, as CPP's `Window::applies` decides (spec, section 1): `all` and `oauth`
 * every model; a family a model whose name holds it; `gemini` and `claude_gpt` the models of that Antigravity group;
 * `model:<name>` that model, also pinned as `<provider>/<name>`; any other scope none.
 */
export function windowApplies(window: Pick<PacerWindow, "scope">, model: string) {
  const name = model.toLowerCase()
  const scope = window.scope.toLowerCase()
  if (scope === "all" || scope === "oauth") return true
  if (FAMILIES.includes(scope)) return name.includes(scope)
  if (scope === "gemini" || scope === "claude_gpt") return antigravityGroup(name) === scope
  if (!scope.startsWith("model:")) return false
  const wanted = scope.slice("model:".length)
  return name === wanted || name.slice(name.indexOf("/") + 1) === wanted
}

/** CPP's `antigravity_group`: which of an Antigravity account's window pairs a model counts against. */
function antigravityGroup(model: string) {
  if (["claude", "gpt", "opus", "sonnet", "haiku", "oss"].some((marker) => model.includes(marker))) return "claude_gpt"
  if (model.includes("gemini")) return "gemini"
  return ""
}

const PROVIDERS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
}

/** Words of CPP's plan IDs that say nothing a reader needs. */
const PLAN_NOISE = new Set(["default", "individual", "tier", "g1"])

/**
 * A group's name (section 2): the provider's, then its plan made readable: split at `_` and `-`, without the words of
 * {@link PLAN_NOISE} and the provider's own name, each word capitalized; the plan as given when no word is left.
 * `claude` + `default_claude_max_20x` → `Claude Max 20x`.
 */
export function usageGroupName(provider: string, plan: string | undefined) {
  const name = groupName(provider, plan)
  return name.plan ? `${name.provider} ${name.plan}` : name.provider
}

/**
 * A group's name at most `width` cells: whole when it fits; else the provider's name is cut and the plan kept, the part
 * that tells two groups of one provider apart (`Comm… Goat`); the plan alone, cut, when not even `C…` fits beside it.
 */
function fitGroupName(provider: string, plan: string | undefined, width: number) {
  const name = groupName(provider, plan)
  const whole = name.plan ? `${name.provider} ${name.plan}` : name.provider
  if (stringWidth(whole) <= width || !name.plan) return Locale.truncateWidth(whole, width)
  const room = width - stringWidth(name.plan) - 1
  if (room < 2) return Locale.truncateWidth(name.plan, width)
  return `${Locale.truncateWidth(name.provider, room)} ${name.plan}`
}

function groupName(provider: string, plan: string | undefined) {
  const name = PROVIDERS[provider.toLowerCase()] ?? provider
  if (!plan) return { provider: name }
  const words = plan
    .split(/[_\-\s]+/)
    .filter(
      (word) => word !== "" && !PLAN_NOISE.has(word.toLowerCase()) && word.toLowerCase() !== provider.toLowerCase(),
    )
  if (words.length === 0) return { provider: name, plan }
  return {
    provider: name,
    plan: words
      .map((word) => (/^\d/.test(word) ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
      .join(" "),
  }
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
 * The time to a reset in one unit, to fit a cell (section 3): `<1m`; minutes, rounded up, under an hour; then hours,
 * then days, rounded down: `46m`, `1h`, `23h`, `6d`.
 */
export function usageCountdown(ms: number) {
  if (ms < 60_000) return "<1m"
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The theme's text color of a part of a line: its role. */
export type UsageInk = "base" | "muted" | "success" | "info" | "warning" | "error"

/** A part of a line of the Usage section, in one color. */
export interface UsageSpan {
  readonly text: string
  readonly ink: UsageInk
  readonly bold?: boolean
}

/** The row's first cells, for its mark. */
const MARK = 2
/** Between two cells. */
const CELL_GAP = 1
const CELL_PERCENT = 4
const CELL_TIME = 4
/** The fewest cells a bar keeps beside the percent; under it the percent goes and the bar takes its room. */
const BAR_WITH_PERCENT = 4
/** The fewest cells a bar keeps at all; more windows than leave it go on another line. */
const BAR = 3

/** A cell `width` wide: its bar, and whether the percent shows. */
function cellLayout(width: number) {
  const percent = width - (1 + CELL_PERCENT + 1 + CELL_TIME) >= BAR_WITH_PERCENT
  return { width, percent, bar: Math.max(0, width - (percent ? 1 + CELL_PERCENT + 1 + CELL_TIME : 1 + CELL_TIME)) }
}

/**
 * The cells of a group with `count` windows on lines `width` wide (section 3): as wide as `perLine` of them on a line
 * allow, never wider than two allow, with as many on a line as keep a bar of {@link BAR} cells.
 */
export function usageCells(width: number, count: number) {
  const widest = Math.floor((width - MARK - CELL_GAP) / 2)
  const cell = (n: number) => cellLayout(Math.min(widest, Math.floor((width - MARK - CELL_GAP * (n - 1)) / n)))
  const fits = Array.from({ length: Math.max(1, count) }, (_, index) => index + 1).filter((n) => cell(n).bar >= BAR)
  const perLine = Math.max(1, ...fits)
  return { ...cell(perLine), perLine }
}

type Mark = "in use" | "last used" | "next use" | "force use"
const MARKS: Record<Mark, { readonly text: string; readonly ink: UsageInk }> = {
  "in use": { text: "●", ink: "success" },
  "last used": { text: "●", ink: "info" },
  "next use": { text: "›", ink: "info" },
  "force use": { text: "›", ink: "warning" },
}

/**
 * The Usage section's lines below its title (spec cliproxypacer-usage-meters, section 2), each at most `width` cells:
 * one group per provider and plan, its header with the windows' labels over their columns, then a row per account
 * without its name, each window that limits `model` a cell of section 3; then the legend of the marks shown. `chat` is
 * `usageAccounts`' view: the marks show only while it is of the model.
 */
export function usageLines(input: {
  readonly accounts: readonly PacerAccount[]
  readonly model: string
  readonly serving: PacerAccount | undefined
  readonly chat: PacerChat | undefined
  readonly running: boolean
  readonly width: number
  readonly now: number
}): UsageSpan[][] {
  const groups = Map.groupBy(input.accounts, (account) => `${account.provider.toLowerCase()}\n${account.plan ?? ""}`)
  const shown = new Set<Mark>()
  const marks = (account: PacerAccount): Mark[] => {
    const chat = input.chat
    if (chat === undefined) return []
    const identity: Mark[] =
      input.serving !== undefined && sameAccount(input.serving, account) ? [input.running ? "in use" : "last used"] : []
    if (chat.forceUse?.account === account.alias) return [...identity, "force use"]
    if (chat.nextUse?.account === account.alias) return [...identity, "next use"]
    return identity
  }
  const lines = Array.from(groups.values())
    .toSorted(
      (a, b) =>
        a[0]!.provider.localeCompare(b[0]!.provider) ||
        Number(a[0]!.plan === undefined) - Number(b[0]!.plan === undefined) ||
        usageGroupName(a[0]!.provider, a[0]!.plan).localeCompare(usageGroupName(b[0]!.provider, b[0]!.plan)),
    )
    .flatMap((group) => {
      const accounts = group.toSorted(
        (a, b) => a.alias.localeCompare(b.alias) || (a.id ?? "").localeCompare(b.id ?? ""),
      )
      const windows = (account: PacerAccount) => account.windows.filter((window) => windowApplies(window, input.model))
      const columns = Array.from(
        new Map(accounts.flatMap(windows).map((window) => [`${window.scope}\n${window.seconds}`, window])).values(),
      ).toSorted(
        (a, b) =>
          Number(a.scope !== "all") - Number(b.scope !== "all") ||
          a.scope.localeCompare(b.scope) ||
          a.seconds - b.seconds,
      )
      const shared = columns.every((column) => column.scope === columns[0]?.scope) ? columns[0]?.scope : undefined
      const cells = usageCells(input.width, columns.length)
      const chunks = Array.from({ length: Math.ceil(columns.length / cells.perLine) }, (_, index) =>
        columns.slice(index * cells.perLine, (index + 1) * cells.perLine),
      )
      const name = (width: number) => fitGroupName(group[0]!.provider, group[0]!.plan, width)
      const header =
        chunks.length === 0
          ? [[{ text: name(input.width), ink: "base", bold: true } satisfies UsageSpan]]
          : chunks.map((chunk, index) =>
              headerLine(
                index === 0 ? name : () => "",
                chunk.map((column) => columnLabel(column, shared, cells.width)),
                cells.width,
              ),
            )
      const rows = accounts.flatMap((account) => {
        const own = marks(account)
        for (const mark of own) shown.add(mark)
        const mark: UsageSpan[] = [
          ...own.map((item) => MARKS[item]),
          ...(own.length < MARK ? [{ text: " ".repeat(MARK - own.length), ink: "muted" as const }] : []),
        ]
        const held = windows(account)
        if (held.length === 0) return [[...mark, { text: "no reading yet", ink: "muted" } satisfies UsageSpan]]
        return chunks.map((chunk, index) => [
          ...(index === 0 ? mark : [{ text: " ".repeat(MARK), ink: "muted" as const }]),
          ...chunk.flatMap((column, at) => [
            ...(at > 0 ? [{ text: " ".repeat(CELL_GAP), ink: "muted" as const }] : []),
            ...cellSpans(
              held.find((window) => window.scope === column.scope && window.seconds === column.seconds),
              cells,
              input.now,
            ),
          ]),
        ])
      })
      return [...header, ...rows]
    })
  const legend = (["in use", "last used", "next use", "force use"] as const)
    .filter((mark) => shown.has(mark))
    .flatMap((mark, index): UsageSpan[] => [
      ...(index > 0 ? [{ text: "  ", ink: "muted" as const }] : []),
      MARKS[mark],
      { text: ` ${mark}`, ink: "muted" },
    ])
  return legend.length > 0 ? [...lines, legend] : lines
}

/** A column's label: its length after its scope, unless that is `all` or every column's; the scope cut to fit. */
function columnLabel(window: PacerWindow, shared: string | undefined, width: number) {
  const length = windowLength(window.seconds)
  if (window.scope === "all" || window.scope === shared) return Locale.truncateWidth(length, width)
  const label = `${window.scope} ${length}`
  if (stringWidth(label) <= width) return label
  const room = width - stringWidth(length) - 1
  return room >= 2 ? `${Locale.truncateWidth(window.scope, room)} ${length}` : Locale.truncateWidth(length, width)
}

/** A group's header line: its name in bold, cut with `…` to end a cell before the first label, each label at its cell's end. */
function headerLine(name: (width: number) => string, labels: readonly string[], cell: number): UsageSpan[] {
  const ends = labels.map((_, index) => MARK + (index + 1) * cell + index * CELL_GAP)
  const starts = labels.map((label, index) => ends[index]! - stringWidth(label))
  const title = name(Math.max(0, starts[0]! - 1))
  const spans: UsageSpan[] = [{ text: title, ink: "base", bold: true }]
  labels.reduce((cursor, label, index) => {
    spans.push({ text: " ".repeat(Math.max(0, starts[index]! - cursor)), ink: "muted" }, { text: label, ink: "muted" })
    return Math.max(cursor, starts[index]!) + stringWidth(label)
  }, stringWidth(title))
  return spans.filter((span) => span.text !== "")
}

/**
 * One window's cell (section 3): a bar of `█` and `░` colored by what is left (muted when the reading isn't current),
 * of `·` when the balance is unknown; the percent left, rounded down, when the cell has room; the time to the reset,
 * `~` in front of CPP's estimate, the length of a dormant window, `now` once the reset has passed with no reading since.
 * Blank where the account has no such window.
 */
function cellSpans(window: PacerWindow | undefined, cell: ReturnType<typeof cellLayout>, now: number): UsageSpan[] {
  if (window === undefined) return [{ text: " ".repeat(cell.width), ink: "muted" }]
  const left = window.left === undefined ? undefined : Math.max(0, Math.min(100, window.left))
  const passed = window.state === "awaiting-confirmation" || (window.resetsAt !== undefined && window.resetsAt <= now)
  const current = window.state !== "dormant" && !passed && left !== undefined && !windowStale(window, now)
  const time = (() => {
    if (window.state === "dormant") return windowLength(window.seconds)
    if (passed) return "now"
    if (window.resetsAt === undefined) return ""
    return `${window.state === "estimated" ? "~" : ""}${usageCountdown(window.resetsAt - now)}`
  })()
  const ink = ((): UsageInk => {
    if (!current) return "muted"
    if (left <= 10) return "error"
    if (left <= 20) return "warning"
    return "success"
  })()
  const filled = left === undefined ? 0 : Math.min(cell.bar, Math.round((left / 100) * cell.bar))
  const percent = left === undefined ? "" : left > 0 && left < 1 ? "<1%" : `${Math.floor(left)}%`
  // A cell without room for the percent shows it in the time's place while no reset is known, so it still says something.
  const tail = time === "" && !cell.percent ? percent : time
  const spans: UsageSpan[] = [
    left === undefined ? { text: "·".repeat(cell.bar), ink: "muted" } : { text: "█".repeat(filled), ink },
    { text: left === undefined ? "" : "░".repeat(cell.bar - filled), ink: "muted" },
    ...(cell.percent
      ? [{ text: ` ${padStart(percent, CELL_PERCENT)}`, ink: current ? "base" : "muted" } as const]
      : []),
    { text: ` ${padStart(tail, CELL_TIME)}`, ink: tail === time ? "muted" : current ? "base" : "muted" },
  ]
  return spans.filter((span) => span.text !== "")
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
