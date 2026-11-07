export * as PacerWire from "./wire.js"

import { Option, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"

// CPP's answers to the reads of the connection (`crates/cpa-server/src/pacer_sessions.rs`, `pacer_api.rs`,
// `crates/cpa-pacer/src/monitor.rs`, `query.rs`), and their conversion into openforge's shapes. CPP leaves out or
// nulls what it does not know, and list entries are decoded one by one, so one this version does not understand drops
// only itself. Every CPP time is Unix ms on CPP's clock; `offset` (CPP's clock minus the service's, from the answers'
// `Date`) turns it into the service's.

const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))
const Items = maybe(Schema.Array(Schema.Unknown))

const Pings = Schema.Struct({
  active: maybe(Schema.Boolean),
  next_ping_at: maybe(Schema.Number),
  pings_left: maybe(Schema.Number),
  pings_sent: maybe(Schema.Number),
  interval_ms: maybe(Schema.Number),
  stopped: maybe(Schema.String),
})

/**
 * A chat's requests at CPP, the generation of its account (a move starts a new one), and when its own settings last
 * changed (`settings_at`, since CPP 2026-11-06; null while it holds none).
 */
const Marks = Schema.Struct({
  requests: maybe(Schema.Number),
  last_at: maybe(Schema.Number),
  generation: maybe(Schema.Number),
  settings_at: maybe(Schema.Number),
})

/** `GET|PATCH /pacer/v1/sessions/{id}`: one chat's state. */
export const View = Schema.Struct({
  id: Schema.String,
  /** CPP's own number for the chat (`sessions.id`), which the request reads filter by; null before its row exists. */
  session_id: maybe(Schema.Number),
  /** The account's `auth_index`. */
  account: maybe(Schema.String),
  provider: maybe(Schema.String),
  model: maybe(Schema.String),
  warm: maybe(Schema.Boolean),
  warm_until: maybe(Schema.Number),
  pings: maybe(Pings),
  /** The chat's own settings, by name; null where it holds none. */
  settings: maybe(Schema.Record(Schema.String, Schema.Unknown)),
  effective: maybe(
    Schema.Struct({
      pings_enabled: maybe(Schema.Boolean),
      compact_before_cold: maybe(Schema.Unknown),
      compact_cold_first: maybe(Schema.Unknown),
    }),
  ),
  /** `size_tokens`: its size by its newest answered request, null while unknown; `threshold`: `warming.fresh_tokens`. */
  warming: maybe(
    Schema.Struct({
      size_tokens: maybe(Schema.Number),
      threshold: maybe(Schema.Number),
      compact_at: maybe(Schema.Number),
      compact_reason: maybe(Schema.String),
    }),
  ),
  next_use: maybe(Schema.Struct({ credential: Schema.String, reason: maybe(Schema.String) })),
  force_use: maybe(Schema.Struct({ credential: Schema.String, when: maybe(Schema.String) })),
  label: maybe(Schema.Unknown),
  ...Marks.fields,
})
export type View = typeof View.Type

/**
 * One chat of `GET /pacer/v1/sessions`: the live part of a view, without `warming`, `next_use`, `force_use` or the
 * switches.
 */
const Listed = Schema.Struct({
  id: Schema.String,
  session_id: maybe(Schema.Number),
  account: maybe(Schema.String),
  model: maybe(Schema.String),
  warm: maybe(Schema.Boolean),
  warm_until: maybe(Schema.Number),
  pings: maybe(Pings),
  ...Marks.fields,
})
export type Listed = typeof Listed.Type

/**
 * What moves a chat's view where the session list can't show it: its requests (pings and compactions too), its account
 * generation, and a write to its own settings (its switches, label or model, by anyone, a removal too), which CPP tells
 * as the chat's `session` notice, not `settings`. Undefined when CPP sends none of them.
 */
export function marks(item: typeof Marks.Type) {
  if (item.requests == null && item.last_at == null && item.generation == null && item.settings_at == null)
    return undefined
  return `${item.requests ?? ""}/${item.last_at ?? ""}/${item.generation ?? ""}/${item.settings_at ?? ""}`
}
export const Sessions = Schema.Struct({ items: Items })

const Window = Schema.Struct({
  scope: maybe(Schema.String),
  seconds: Schema.Number,
  left: maybe(Schema.Number),
  reset: maybe(Schema.Number),
  usage_at: maybe(Schema.Number),
  label: maybe(Schema.String),
  state: maybe(Schema.String),
  not_applicable: maybe(Schema.Boolean),
})
const Meter = Schema.Struct({
  auth_index: Schema.String,
  provider: Schema.String,
  /** The alias (a client key never sees an e-mail address). */
  label: maybe(Schema.String),
  plan: maybe(Schema.String),
  windows: Items,
})
export type Meter = typeof Meter.Type
/** `GET /pacer/v1/meters`. */
export const Meters = Schema.Array(Schema.Unknown)

const Tree = Schema.Struct({ id: Schema.Number, ext: Schema.String, descendants: Items })
const Live = Schema.Struct({
  id: Schema.String,
  warm: maybe(Schema.Boolean),
  warm_until: maybe(Schema.Number),
  pings: maybe(Pings),
})
/** `GET /pacer/v1/state`: what the connection reads before it follows the stream. */
export const State = Schema.Struct({
  meters: Items,
  sessions: maybe(Schema.Struct({ items: Items })),
  live: maybe(Schema.Record(Schema.String, Schema.Unknown)),
})

/** A request row of `GET /pacer/v1/monitor/requests` (`RequestRow`); the prompt read's `request` lacks the last three. */
const Row = Schema.Struct({
  id: Schema.Number,
  at: Schema.Number,
  ext: Schema.String,
  provider: maybe(Schema.String),
  model: maybe(Schema.String),
  /** The model the client asked for. */
  alias: maybe(Schema.String),
  kind: maybe(Schema.Number),
  status: maybe(Schema.Number),
  failed: maybe(Schema.Boolean),
  input: maybe(Schema.Number),
  output: maybe(Schema.Number),
  reasoning: maybe(Schema.Number),
  cache_read: maybe(Schema.Number),
  cache_write_5m: maybe(Schema.Number),
  cache_write_1h: maybe(Schema.Number),
  cache_write_other: maybe(Schema.Number),
  /** Nano-USD. */
  cost_api: maybe(Schema.Number),
  cache_verdict: maybe(Schema.String),
  cache_cause: maybe(Schema.String),
  cache_shortfall: maybe(Schema.Number),
  miss_cost: maybe(Schema.Number),
  changed_part: maybe(Schema.String),
  /** The numeric id of the request the verdict compared with. */
  cache_base: maybe(Schema.Number),
  refusal: maybe(Schema.String),
  /** The chat's ID as the client sent it. */
  session_ext: maybe(Schema.String),
  subagent: maybe(Schema.Boolean),
  /** The account's alias. */
  account: maybe(Schema.String),
})
export type Row = typeof Row.Type
export const Rows = Schema.Struct({ items: Items, next: maybe(Schema.String) })

const PromptRow = Schema.Struct({
  path: Schema.String,
  kind: Schema.String,
  summary: maybe(Schema.String),
  chars: maybe(Schema.Number),
  /**
   * first, new, same, marker or changed; since CPP 2026-11-06 also billing: Claude Code's billing block, which differs
   * on every request and the cache counts as no change.
   */
  change: Schema.String,
  error: maybe(Schema.Boolean),
})
/** `GET /pacer/v1/prompts/{ext}?rows=1`. */
export const Prompt = Schema.Struct({
  kept: maybe(Schema.Boolean),
  previous: maybe(Schema.Number),
  removed: maybe(Schema.Array(Schema.String)),
  rows: Items,
})
export type Prompt = typeof Prompt.Type

/**
 * One row of `GET|PATCH /pacer/v1/settings` (cpa-pacer `settings.rs`, `settings_listing`): a setting the key may set,
 * with `value` what applies to the key, its own else the server's else the default; `server` is null while the server
 * holds none.
 */
const Setting = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.Unknown),
  server: Schema.optional(Schema.Unknown),
  default: Schema.optional(Schema.Unknown),
})
/** `GET|PATCH /pacer/v1/settings`: the key level's listing. */
export const Settings = Schema.Array(Schema.Unknown)

/** A change stream notice's `data`. */
const Notice = Schema.Struct({
  sessions: maybe(Schema.Array(Schema.Struct({ session: Schema.String }))),
  many: maybe(Schema.Boolean),
})

const decodeListed = Schema.decodeUnknownOption(Listed)
const decodeWindow = Schema.decodeUnknownOption(Window)
const decodeMeter = Schema.decodeUnknownOption(Meter)
const decodeTree = Schema.decodeUnknownOption(Tree)
const decodeLive = Schema.decodeUnknownOption(Live)
const decodeRow = Schema.decodeUnknownOption(Row)
const decodePromptRow = Schema.decodeUnknownOption(PromptRow)
const decodeSetting = Schema.decodeUnknownOption(Setting)
const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(Notice))

export const each = <A>(
  items: ReadonlyArray<unknown> | null | undefined,
  decode: (item: unknown) => Option.Option<A>,
) => (items ?? []).flatMap((item) => Option.toArray(decode(item)))

export const listed = (items: ReadonlyArray<unknown> | null | undefined) => each(items, decodeListed)
export const meters = (items: ReadonlyArray<unknown> | null | undefined) => each(items, decodeMeter)
export const rows = (items: ReadonlyArray<unknown> | null | undefined) => each(items, decodeRow)
export const row = (item: unknown) => Option.getOrUndefined(decodeRow(item))

/** The chats `GET /pacer/v1/state` lists (with their subagents), by CPP's UUID, with their numbers and live state. */
export function active(state: typeof State.Type) {
  const trees = each(state.sessions?.items, decodeTree)
  const numbers = new Map(
    trees.flatMap((tree) => [
      [tree.ext, tree.id] as const,
      ...each(tree.descendants, decodeTree).map((child) => [child.ext, child.id] as const),
    ]),
  )
  const live = Object.values(state.live ?? {}).flatMap((item) => Option.toArray(decodeLive(item)))
  return { numbers, live }
}

/** The key-level settings behind `Pacer.Settings`, by their names at CPP. */
export const settingNames = {
  compactColdFirst: "warming.compact_cold_first",
  compactBeforeCold: "warming.compact_before_cold",
} as const

/** The compaction asks for all chats, as CPP's listing says they apply to the key; one it doesn't list is off. */
export function settings(items: ReadonlyArray<unknown>): Pacer.Settings {
  const values = new Map(each(items, decodeSetting).map((item) => [item.name, item.value]))
  return {
    compactColdFirst: values.get(settingNames.compactColdFirst) === true,
    compactBeforeCold: values.get(settingNames.compactBeforeCold) === true,
  }
}

/**
 * The key level's write for `change` (values by CPP's names), given CPP's listing: `null`, which clears the key's own,
 * where a value is what CPP applies without it (the server's, else the default), so that a server default the owner
 * sets later reaches the key's chats (spec cliproxypacer-cold-ask, the decision of 2026-11-07); else the value itself,
 * also for a setting CPP doesn't list.
 */
export function keyChange(items: ReadonlyArray<unknown>, change: Readonly<Record<string, unknown>>) {
  const rows = new Map(each(items, decodeSetting).map((item) => [item.name, item]))
  return Object.fromEntries(
    Object.entries(change).map(([name, value]) => {
      const row = rows.get(name)
      return [name, row !== undefined && (row.server ?? row.default) === value ? null : value]
    }),
  )
}

/** What a notice names: the chats a `compact` notice asks to compact, or `many`. */
export function notice(data: string) {
  const decoded = Option.getOrUndefined(decodeNotice(data))
  return { sessions: (decoded?.sessions ?? []).map((item) => item.session.toLowerCase()), many: decoded?.many === true }
}

export interface Context {
  /** CPP's clock minus the service's, in ms. */
  readonly offset: number
  /** The service's clock now. */
  readonly now: number
}

/** A CPP time on the service's clock; undefined for CPP's "unknown" (absent, null or 0). */
export function local(time: number | null | undefined, offset: number) {
  return typeof time === "number" && Number.isFinite(time) && time > 0 ? time - offset : undefined
}

/** `pings.stopped` values that mean the pings ended on a failure, not as planned or by a switch. */
const failures = new Set(["cold", "account_changed", "unauthorized", "floored"])

/** The parts of a chat's view the session list also carries. */
export function live(
  item: Pick<Listed, "warm" | "warm_until" | "pings">,
  context: Context,
): Pick<Pacer.Chat, "warm" | "warmUntil" | "coldAt" | "pings"> {
  const warmUntil = local(item.warm_until, context.offset)
  const warm = item.warm === true
  const pings = item.pings
  const active = pings?.active === true
  const left = count(pings?.pings_left)
  const intervalMs = count(pings?.interval_ms) || undefined
  const nextAt = local(pings?.next_ping_at, context.offset)
  const stopped = pings?.stopped ?? undefined
  return {
    warm,
    ...(warmUntil !== undefined ? { warmUntil } : {}),
    // The countdown runs to the end of the pings planned, so it does not jump forward at each ping as warm_until does.
    ...(warm && warmUntil !== undefined
      ? { coldAt: active && intervalMs !== undefined ? warmUntil + left * intervalMs : warmUntil }
      : {}),
    pings: {
      active,
      ...(nextAt !== undefined ? { nextAt } : {}),
      left,
      sent: count(pings?.pings_sent),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(stopped ? { stopped } : {}),
      failed: stopped !== undefined && failures.has(stopped),
    },
  }
}

/**
 * A chat's view in openforge's shape; `alias` names an account by its `auth_index`. CPP names the next and the forced
 * account as a client sees it: the alias its meters carry, which since CPP 2026-11-06 an account without a label has
 * too (`<provider> <six hex digits>`). Before, CPP gave such an account's `auth_index`, which `alias` names as the
 * accounts do. The serving account also goes by its `auth_index` (`accountID`): CPP names two logins of one address
 * alike, and the meters list both, each with its own readings.
 */
export function chat(
  view: View,
  sessionID: SessionID,
  context: Context & { readonly alias: (account: string) => string },
): Pacer.Chat {
  const compactAt = local(view.warming?.compact_at, context.offset)
  const reason = view.warming?.compact_reason
  const when = view.force_use?.when
  const warming = view.effective?.pings_enabled === true
  const state = live(view, context)
  const size = view.warming?.size_tokens
  const threshold = view.warming?.threshold
  return {
    sessionID,
    ...(view.model ? { model: view.model } : {}),
    ...(view.provider ? { provider: view.provider } : {}),
    ...(view.account ? { account: context.alias(view.account), accountID: view.account } : {}),
    ...state,
    // With warming off no ping goes out. CPP's answer to the write that turns it off can still list the pings planned,
    // until its list says otherwise about a second on (run/evidence/v0.0.7/live-owner-4): they don't move the countdown.
    ...(!warming && state.coldAt !== undefined ? { coldAt: state.warmUntil } : {}),
    ...(compactAt !== undefined && (reason === "before-cold" || reason === "cold")
      ? { compactAt, compactReason: reason }
      : {}),
    ...(view.next_use
      ? { nextUse: { account: context.alias(view.next_use.credential), reason: view.next_use.reason ?? "" } }
      : {}),
    ...(view.force_use && (when === "now" || when === "soon")
      ? { forceUse: { account: context.alias(view.force_use.credential), when } }
      : {}),
    switches: {
      warming,
      compactBeforeCold: view.effective?.compact_before_cold === true,
      compactColdFirst: view.effective?.compact_cold_first === true,
    },
    ...(typeof size === "number" && typeof threshold === "number"
      ? { size: { tokens: count(size), threshold: count(threshold) } }
      : {}),
    asOf: context.now,
  }
}

/** A reading turns stale an hour after it was read: CPP's routing stops counting on it then. */
export const STALE_MS = 3_600_000

const windowStates = new Set<string>([
  "current",
  "estimated",
  "partial",
  "unknown",
  "dormant",
  "awaiting-confirmation",
] satisfies Pacer.WindowState[])
const isWindowState = (state: string): state is Pacer.WindowState => windowStates.has(state)

/** Every account of the meters, by its `auth_index` and alias, with the windows that apply to it. */
export function accounts(items: ReadonlyArray<Meter>, context: Context): Pacer.Accounts {
  return {
    items: items.map((meter) => ({
      id: meter.auth_index,
      alias: meter.label || meter.auth_index,
      provider: meter.provider,
      ...(meter.plan ? { plan: meter.plan } : {}),
      windows: each(meter.windows, decodeWindow).flatMap((item): Pacer.Window[] => {
        if (item.not_applicable === true || item.state === "not-applicable") return []
        const state = item.state && isWindowState(item.state) ? item.state : "unknown"
        const readAt = local(item.usage_at, context.offset)
        const scope = item.scope || "all"
        const length = item.label || duration(item.seconds)
        const left = typeof item.left === "number" ? Math.min(100, Math.max(0, item.left)) : undefined
        const resetsAt = local(item.reset, context.offset)
        const staleAt = readAt !== undefined ? readAt + STALE_MS : undefined
        return [
          {
            label: scope === "all" ? length : `${length} ${scope}`,
            scope,
            seconds: count(item.seconds),
            ...(left !== undefined ? { left } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
            ...(readAt !== undefined ? { readAt } : {}),
            state,
            stale:
              state === "unknown" ||
              state === "awaiting-confirmation" ||
              (staleAt !== undefined && context.now >= staleAt),
            ...(staleAt !== undefined ? { staleAt } : {}),
          },
        ]
      }),
    })),
    asOf: context.now,
  }
}

const kinds: ReadonlyArray<Pacer.Kind> = ["step", "ping", "title", "compaction", "other", "probe", "search"]

/** Who sent a row: the service's chat for CPP's UUID, and a subagent's agent. */
export interface Sender {
  readonly sessionID?: SessionID
  readonly agent?: string
}

/**
 * A row's request ID: CPP's (`ext`), else its row's ({@link Pacer.rowRequestID}). CPP records a web tool call without
 * one (spec cliproxypacer-step-2), so all such rows of a chat went by the same empty ID.
 */
export const requestID = (row: Pick<Row, "id" | "ext">) => row.ext || Pacer.rowRequestID(row.id)

/** A request row in openforge's shape. */
export function request(row: Row, sender: Sender, context: Context): Pacer.Request {
  const verdict = row.cache_verdict ?? undefined
  const subagent = row.subagent === true
  return {
    id: requestID(row),
    at: local(row.at, context.offset) ?? row.at,
    ...(sender.sessionID ? { sessionID: sender.sessionID } : {}),
    subagent,
    ...(subagent && sender.agent ? { agent: Agent.ID.make(sender.agent) } : {}),
    kind: kinds[row.kind ?? -1] ?? "other",
    model: row.alias || row.model || "",
    provider: row.provider ?? "",
    ...(row.account ? { account: row.account } : {}),
    status: count(row.status),
    failed: row.failed === true,
    ...(row.refusal ? { refusal: row.refusal } : {}),
    tokens: {
      input: count(row.input),
      output: count(row.output),
      reasoning: count(row.reasoning),
      cacheRead: count(row.cache_read),
      cacheWrite: count(row.cache_write_5m) + count(row.cache_write_1h) + count(row.cache_write_other),
    },
    ...(typeof row.cost_api === "number" ? { cost: usd(row.cost_api) } : {}),
    ...(verdict ? { verdict } : {}),
    miss: verdict === "miss" || verdict === "partial",
    ...(row.cache_cause ? { cause: row.cache_cause } : {}),
    ...(row.changed_part ? { changedPart: row.changed_part } : {}),
    ...(typeof row.cache_shortfall === "number" && row.cache_shortfall > 0
      ? { rewritten: count(row.cache_shortfall) }
      : {}),
    ...(typeof row.miss_cost === "number" ? { missCost: usd(row.miss_cost) } : {}),
  }
}

/**
 * What changed in a request's prompt. `prompt` is undefined when CPP holds no prompt for it any more; `comparedWith` is
 * the request it was compared with, its time on the service's clock.
 */
export function promptChange(
  prompt: Prompt | undefined,
  request: Pacer.Request,
  comparedWith: { readonly id: string; readonly at: number } | undefined,
  context: Context,
): Pacer.PromptChange {
  const items = each(prompt?.rows, decodePromptRow)
  const changed = items.flatMap((item): Pacer.PromptItem[] =>
    item.change === "changed" || item.change === "new" || item.change === "marker"
      ? [
          {
            path: item.path,
            kind: item.kind,
            summary: item.summary ?? "",
            chars: count(item.chars),
            change: item.change,
            error: item.error === true,
          },
        ]
      : [],
  )
  const dropped = items.length > 0 && items.every((item) => item.kind === "dropped")
  return {
    request,
    ...(comparedWith ? { comparedWith: { id: comparedWith.id, at: comparedWith.at } } : {}),
    kept: prompt === undefined || dropped ? "none" : prompt.kept === false ? "part" : "all",
    items: changed,
    removed: prompt?.removed ?? [],
    unchanged: items.length - changed.length,
    asOf: context.now,
  }
}

/** A window's length as CPP labels it: `5h`, `7d`, `90m`. */
function duration(seconds: number) {
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`
  return `${count(seconds)}s`
}

function count(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function usd(nano: number) {
  return Money.USD.make(nano / 1e9)
}
