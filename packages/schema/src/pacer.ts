export * as Pacer from "./pacer.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { ephemeral, inventory } from "./event.js"
import { Money } from "./money.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"

// openforge's own shapes of what CLIProxyPacer (CPP) says about its accounts and the chats on it. The service's
// connection to CPP fills them; TUIs read them through the `pacer.*` routes (under /api/experimental/pacer) and the
// `pacer.*` events. They use no CPP wire names or numbers, so that a version without CPP can fill them too. Every
// time is Unix milliseconds on the service's clock: CPP's times corrected by its answers' `Date` header.

const Instant = Schema.Finite.annotate({ description: "Milliseconds since the Unix epoch, on the service's clock" })
const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

/**
 * `unset`: no CPP is set up (no base URL or no key). `unreachable`: CPP doesn't answer, or refused the key.
 * `no-pacer`: the proxy answers but has no pacer, such as a plain CLIProxyAPI. `on`: the pacer answers; its change
 * stream is followed, connected beside it.
 */
export const State = Schema.Literals(["unset", "unreachable", "no-pacer", "on"]).annotate({ identifier: "Pacer.State" })
export type State = typeof State.Type

/** The service's one connection to CPP, shared by all its TUIs. */
export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  state: State,
  /** When the connection entered this state. */
  since: Instant,
  /** When CPP last answered; while it is unreachable, the time the last values are from ("as of 14:02"). */
  asOf: Instant.pipe(optional),
  /** Why it is unreachable or has no pacer, in words. */
  message: Schema.String.pipe(optional),
  /** CPP refused the key (401 or 403): the service tries again only once the address or the key changes. */
  refused: Schema.Boolean,
}).annotate({ identifier: "Pacer.Status" })

/**
 * What a window's reading says. `current`: its balance and reset are known. `estimated`: both are known, the reset
 * is CPP's estimate. `partial`: its balance or its reset is unknown. `unknown`: both are. `dormant`: it hasn't started
 * (nothing used since its last reset). `awaiting-confirmation`: its reset has passed and no reading since says what
 * the new window holds.
 */
export const WindowState = Schema.Literals([
  "current",
  "estimated",
  "partial",
  "unknown",
  "dormant",
  "awaiting-confirmation",
]).annotate({ identifier: "Pacer.WindowState" })
export type WindowState = typeof WindowState.Type

/** One quota window of an account. */
export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  /** Its length, with its scope when it doesn't cover every model: `5h`, `7d`, `7d opus`. */
  label: Schema.String,
  /** The models it covers: `all`, or a family such as `opus`, `sonnet` or `gemini`. */
  scope: Schema.String,
  /** Its length in seconds. */
  seconds: NonNegativeInt,
  /** Percent of the window left; absent while unknown. */
  left: Percent.pipe(optional),
  /** When it resets; absent while unknown. */
  resetsAt: Instant.pipe(optional),
  /** When `left` was read. */
  readAt: Instant.pipe(optional),
  state: WindowState,
  /**
   * The reading can't be trusted now: it is older than an hour (when CPP's routing stops counting on it), or it says
   * nothing of the window as it is (`unknown`, `awaiting-confirmation`). As of when it was answered; `staleAt` says
   * when a reading turns stale without anything new being sent.
   */
  stale: Schema.Boolean,
  /** When the reading turns stale: an hour after `readAt`. */
  staleAt: Instant.pipe(optional),
}).annotate({ identifier: "Pacer.Window" })

/** An account CPP spreads chats over. */
export interface Account extends Schema.Schema.Type<typeof Account> {}
export const Account = Schema.Struct({
  /**
   * CPP's opaque ID of the credential (its `auth_index`). Two logins of one address share an alias, each with its own
   * readings: a chat's account is found by this ID (`Chat.accountID`).
   */
  id: Schema.String.pipe(optional),
  /** CPP's alias of the account, the same in all of its answers to the key; never an e-mail address. */
  alias: Schema.String,
  /** CPP's provider of the account, such as `claude`, `codex` or `antigravity`. */
  provider: Schema.String,
  /** Its plan, as the provider names it. */
  plan: Schema.String.pipe(optional),
  /** Its quota windows; those that don't apply to it are left out. */
  windows: Schema.Array(Window),
}).annotate({ identifier: "Pacer.Account" })

/** Every account the key sees, as last read. */
export interface Accounts extends Schema.Schema.Type<typeof Accounts> {}
export const Accounts = Schema.Struct({
  items: Schema.Array(Account),
  /** When they were read. */
  asOf: Instant,
}).annotate({ identifier: "Pacer.Accounts" })

/** The pings CPP sends to keep a chat's prompt cache warm while nothing else is sent. */
export interface Pings extends Schema.Schema.Type<typeof Pings> {}
export const Pings = Schema.Struct({
  /** Pings are planned: CPP keeps the cache warm until they run out or the chat sends again. */
  active: Schema.Boolean,
  nextAt: Instant.pipe(optional),
  /** Pings still planned. */
  left: NonNegativeInt,
  /** Pings sent since the chat's last request. */
  sent: NonNegativeInt,
  /** The time between two pings, in milliseconds. */
  intervalMs: NonNegativeInt.pipe(optional),
  /**
   * Why the last pings ended, while CPP remembers: `done`, `off`, `cold`, `account_changed`, `disabled`,
   * `unauthorized`, `floored`, `no_body`, `event` or `compacted`.
   */
  stopped: Schema.String.pipe(optional),
  /**
   * They ended on a failure (`stopped` is `cold`, `account_changed`, `unauthorized` or `floored`), rather than as
   * planned or by a switch.
   */
  failed: Schema.Boolean,
}).annotate({ identifier: "Pacer.Pings" })

/** Where the chat goes once its cache is cold. */
export interface NextUse extends Schema.Schema.Type<typeof NextUse> {}
export const NextUse = Schema.Struct({
  /** The account's alias. */
  account: Schema.String,
  /** `cold_move`: the cache will be cold, so the chat may move freely; `forced_move`: its account can't keep it. */
  reason: Schema.String,
}).annotate({ identifier: "Pacer.NextUse" })

/** Where a forced move sends the chat. */
export interface ForceUse extends Schema.Schema.Type<typeof ForceUse> {}
export const ForceUse = Schema.Struct({
  /** The account's alias. */
  account: Schema.String,
  /** `now`: the chat's account can't serve its next step; `soon`: it is close to a floor. */
  when: Schema.Literals(["now", "soon"]),
}).annotate({ identifier: "Pacer.ForceUse" })

/** The chat's own switches, as they resolve for it on CPP. */
export interface Switches extends Schema.Schema.Type<typeof Switches> {}
export const Switches = Schema.Struct({
  /** CPP pings the chat to keep its cache warm (off for a model CPP doesn't ping unless switched on). */
  warming: Schema.Boolean,
  /** CPP asks to compact the chat before its cache goes cold. */
  compactBeforeCold: Schema.Boolean,
  /**
   * CPP asks to compact the chat first, on a cheap model it picks, when its cache has gone cold and it is at least
   * `Chat.size.threshold` large; then its next step goes out from the summary.
   */
  compactColdFirst: Schema.Boolean,
}).annotate({ identifier: "Pacer.Switches" })

/** How large the chat is, against the size from which CPP compacts a cold chat first. */
export interface Size extends Schema.Schema.Type<typeof Size> {}
export const Size = Schema.Struct({
  /** Tokens of its prompt, by its newest answered step. */
  tokens: NonNegativeInt,
  /** CPP's `warming.fresh_tokens` for the chat: a cold chat this large or larger compacts first. */
  threshold: NonNegativeInt,
}).annotate({ identifier: "Pacer.Size" })

/** One chat as CPP sees it. */
export interface Chat extends Schema.Schema.Type<typeof Chat> {}
export const Chat = Schema.Struct({
  sessionID: SessionID,
  /** CPP's model for the chat. */
  model: Schema.String.pipe(optional),
  /** The provider of the account serving it. */
  provider: Schema.String.pipe(optional),
  /** The alias of the account serving the chat, or of the one that served it last. */
  account: Schema.String.pipe(optional),
  /** That account's `Account.id`: the alias may name two logins of one address. */
  accountID: Schema.String.pipe(optional),
  /** Its prompt cache is warm now. */
  warm: Schema.Boolean,
  /** When the cache goes cold unless something is sent: moves forward at every ping. */
  warmUntil: Instant.pipe(optional),
  /**
   * When the cache goes cold if nothing more is sent, the toolbar's countdown: `warmUntil` plus the pings left times
   * their interval while pings are planned and warming is on, else `warmUntil`. Unlike `warmUntil` it doesn't move at each
   * ping.
   */
  coldAt: Instant.pipe(optional),
  pings: Pings,
  /** When CPP asks (or asked) to compact the chat, while it does. */
  compactAt: Instant.pipe(optional),
  /** `before-cold`: compact before the cache goes cold; `cold`: compact the cold chat before its next step. */
  compactReason: Schema.Literals(["before-cold", "cold"]).pipe(optional),
  nextUse: NextUse.pipe(optional),
  forceUse: ForceUse.pipe(optional),
  switches: Switches,
  /** Its size and CPP's threshold for it; absent until CPP knows its size (it has no answered step yet). */
  size: Size.pipe(optional),
  /** When it was read. */
  asOf: Instant,
}).annotate({ identifier: "Pacer.Chat" })

/** A change to a chat's switches; an absent switch stays as it is. */
export interface ChatUpdate extends Schema.Schema.Type<typeof ChatUpdate> {}
export const ChatUpdate = Schema.Struct({
  warming: Schema.Boolean.pipe(optional),
  compactBeforeCold: Schema.Boolean.pipe(optional),
  compactColdFirst: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Pacer.ChatUpdate" })

/** Who writes a chat's summaries when it compacts: CLIProxyPacer, or openforge itself. */
export const SummaryWriter = Schema.Literals(["cliproxypacer", "openforge"]).annotate({
  identifier: "Pacer.SummaryWriter",
})
export type SummaryWriter = typeof SummaryWriter.Type

/**
 * CPP's compaction asks for all of the key's chats: its key level, as it applies to them (the key's own value, else
 * the server's, else the default). A chat's own switch (`Switches`) wins over it.
 */
export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  /** Compact a cold, large chat first, on a cheap model CPP picks (`Switches.compactColdFirst`). */
  compactColdFirst: Schema.Boolean,
  /** Compact a chat before its cache goes cold (`Switches.compactBeforeCold`). */
  compactBeforeCold: Schema.Boolean,
  /**
   * Who writes the chats' summaries: CLIProxyPacer (its `compaction.writer` `server`, or unset) or openforge
   * (`client`). Absent while the service can't tell.
   */
  summaryWriter: SummaryWriter.pipe(optional),
  /**
   * CLIProxyPacer keeps the user's own earlier messages after its summaries (`compaction.user_messages`). Absent while
   * the service can't tell.
   */
  keepUserMessages: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Pacer.Settings" })

/** A change to the compaction asks for all chats, at the key level; an absent ask stays as it is. */
export interface SettingsUpdate extends Schema.Schema.Type<typeof SettingsUpdate> {}
export const SettingsUpdate = Schema.Struct({
  compactColdFirst: Schema.Boolean.pipe(optional),
  compactBeforeCold: Schema.Boolean.pipe(optional),
  summaryWriter: SummaryWriter.pipe(optional),
  keepUserMessages: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Pacer.SettingsUpdate" })

/** What a request was. A subagent's step is a `step` whose request has `subagent` set. */
export const Kind = Schema.Literals(["step", "ping", "title", "compaction", "other", "probe", "search"]).annotate({
  identifier: "Pacer.Kind",
})
export type Kind = typeof Kind.Type

export interface Tokens extends Schema.Schema.Type<typeof Tokens> {}
export const Tokens = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
  cacheRead: NonNegativeInt,
  /** Written to the cache, for every lifetime together. */
  cacheWrite: NonNegativeInt,
}).annotate({ identifier: "Pacer.Tokens" })

/**
 * The `id` of a request CPP recorded without a request ID, as it does a call of its web tools (spec
 * cliproxypacer-step-2): `row:` and CPP's number for its row, distinct and stable across reads. CPP's request IDs are
 * UUIDs, so the two never meet.
 */
export const rowRequestID = (row: number) => `row:${row}`

/** Whether a request's `id` is its row's ({@link rowRequestID}): it sent no prompt, so it has none to compare. */
export const promptless = (requestID: string) => requestID.startsWith("row:")

/** One request CPP recorded for a chat or one of its subagents. */
export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  /**
   * CPP's request ID: the `proxyRequestID` of the assistant message whose step sent it. A request without one, such as
   * a web tool call, goes by its row ({@link rowRequestID}) and has no prompt.
   */
  id: Schema.String,
  /**
   * When CPP received it. Held once answered, for the last 1,000 rows read: later answers give the same time, though
   * the correction of CPP's clock narrows. A row read again after 1,000 others, after a restart or from another CPP is
   * corrected anew, so its time may move (by about a second, unless CPP's clock jumped).
   */
  at: Instant,
  /** The chat that sent it: the subagent's own for a subagent's request; absent when it isn't one of this service's. */
  sessionID: SessionID.pipe(optional),
  /** A subagent's chat sent it. */
  subagent: Schema.Boolean,
  /** The subagent's agent, for a subagent's request. */
  agent: Agent.ID.pipe(optional),
  kind: Kind,
  /** The model the chat asked for. */
  model: Schema.String,
  /** The provider of the account that served it. */
  provider: Schema.String,
  /** The alias of the account that served it; absent when CPP refused it before choosing one. */
  account: Schema.String.pipe(optional),
  /** The HTTP status of its answer. */
  status: NonNegativeInt,
  failed: Schema.Boolean,
  /** Why CPP refused it before trying any account. */
  refusal: Schema.String.pipe(optional),
  tokens: Tokens,
  /** What it cost at API prices. */
  cost: Money.USD.pipe(optional),
  /**
   * CPP's cache verdict: `hit`, `miss`, `partial`, `shared`, `cold` or `unreported` (the provider didn't report what
   * it wrote); absent without one (failed, no usage, not a step).
   */
  verdict: Schema.String.pipe(optional),
  /** The verdict is a miss as CPP counts them (`miss` or `partial`): shown as a warning. */
  miss: Schema.Boolean,
  /** Why the cache missed. */
  cause: Schema.String.pipe(optional),
  /** The first part of the prompt that changed, as the verdict names it. */
  changedPart: Schema.String.pipe(optional),
  /** Tokens written to the cache again that it should have read. */
  rewritten: NonNegativeInt.pipe(optional),
  /** What the miss cost beyond a hit. */
  missCost: Money.USD.pipe(optional),
}).annotate({ identifier: "Pacer.Request" })

/** Which of a chat's requests to list: all, or only misses (`miss` and `partial`). */
export const Filter = Schema.Literals(["all", "misses"]).annotate({ identifier: "Pacer.Filter" })
export type Filter = typeof Filter.Type

/** One page of a chat's requests with its subagents', newest first. */
export interface Requests extends Schema.Schema.Type<typeof Requests> {}
export const Requests = Schema.Struct({
  items: Schema.Array(Request),
  /** Pass it back for the next, older page; absent on the last one. */
  cursor: Schema.String.pipe(optional),
  /** When the page was read. */
  asOf: Instant,
}).annotate({ identifier: "Pacer.Requests" })

/** One block of a prompt that differs from the prompt it was compared with. */
export interface PromptItem extends Schema.Schema.Type<typeof PromptItem> {}
export const PromptItem = Schema.Struct({
  /** Where it sits in the prompt: `messages[3].content[1]`. */
  path: Schema.String,
  /**
   * `option`, `system`, `tool`, `prompt`, `reminder`, `assistant`, `call`, `result`, `thinking`, `image`, `file`,
   * `other`, or `dropped` (CPP kept only its fingerprint).
   */
  kind: Schema.String,
  summary: Schema.String,
  /** Its size in characters. */
  chars: NonNegativeInt,
  /** `changed`, `new` (the compared prompt had nothing there), or `marker` (only its cache marker moved). */
  change: Schema.Literals(["changed", "new", "marker"]),
  /** A tool result marked as an error. */
  error: Schema.Boolean,
}).annotate({ identifier: "Pacer.PromptItem" })

/** What changed in a request's prompt against the one CPP compared it with. */
export interface PromptChange extends Schema.Schema.Type<typeof PromptChange> {}
export const PromptChange = Schema.Struct({
  /** The request, with its verdict, cause, tokens written again and what the miss cost. */
  request: Request,
  /** The request it was compared with; absent when there was none (the chat's first). */
  comparedWith: Schema.Struct({
    /** CPP's request ID, as `Request.id`. */
    id: Schema.String,
    /** When CPP received it, held as `Request.at`. */
    at: Instant,
  }).pipe(optional),
  /**
   * Whether CPP still holds the prompt. `all`: every item. `part`: retention left only fingerprints of some (their
   * rows are `dropped`, without a summary). `none`: CPP holds no prompt for it ("prompt no longer kept").
   */
  kept: Schema.Literals(["all", "part", "none"]),
  /** The blocks that changed, are new, or only had their cache marker moved, in prompt order. */
  items: Schema.Array(PromptItem),
  /** Where the compared prompt had items this one doesn't. */
  removed: Schema.Array(Schema.String),
  /** How many blocks are the same. */
  unchanged: NonNegativeInt,
  /** When it was read. */
  asOf: Instant,
}).annotate({ identifier: "Pacer.PromptChange" })

/** The connection's state changed. */
const StatusChanged = ephemeral({ type: "pacer.status", schema: { status: Status } })
/** The accounts were read again and changed. */
const AccountsUpdated = ephemeral({ type: "pacer.accounts.updated", schema: { accounts: Accounts } })
/**
 * A chat's view changed (apart from `asOf`), with the new one: when a read of the view answered it, or a write of its
 * switches or of its pings' duration; when CPP's state or chat list (read at each connect, on `resync` and `session`
 * notices, and on a `compact` notice for many chats) brought new warmth, pings, account or model for a view held; and
 * when a compaction of the chat ended while its view had a `compactAt`, which goes at once. Dropping a view sends none.
 */
const ChatUpdated = ephemeral({ type: "pacer.chat.updated", schema: { chat: Chat } })
/**
 * CPP recorded new requests for a chat or one of its subagents: one event for the chat and one for each of its
 * parents. Requests of a chat this service doesn't hold yet are told once it does, for the newest 200 such chats.
 * Without `sessionID` when CPP had more new requests than one read takes (50 on the first read, 500 after): any chat
 * may have some. A TUI showing a chat whose requests it holds reads their first page again when the event names that
 * chat, or none.
 */
const RequestsUpdated = ephemeral({
  type: "pacer.requests.updated",
  schema: { sessionID: SessionID.pipe(optional) },
})

export const Event = {
  StatusChanged,
  AccountsUpdated,
  ChatUpdated,
  RequestsUpdated,
  Definitions: inventory(StatusChanged, AccountsUpdated, ChatUpdated, RequestsUpdated),
}
