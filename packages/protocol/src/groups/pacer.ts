import { Pacer } from "@opencode/schema/pacer"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, LocationNotFoundError, ServiceUnavailableError, SessionNotFoundError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
export const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.pacer.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

const ChatParams = { sessionID: Session.ID }

export const RequestsQuery = Schema.Struct({
  filter: Schema.optional(Pacer.Filter).annotate({
    description: "`misses` lists only cache misses (`miss` and `partial`); `all`, the default, every request.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({ description: "The previous page's `cursor`, for the next, older page." }),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ).annotate({ description: "Rows per page; 50 when omitted." }),
}).annotate({ identifier: "Pacer.RequestsQuery" })

/** A field passed on to CLIProxyPacer as given; CLIProxyPacer checks it. */
const field = (description: string) => Schema.optional(Schema.String.annotate({ description }))
const format = field("`text` for the memory tools' own lines (`text/plain`); JSON when omitted.")
const cursor = field("The `next` of the page before (in a text answer, its `X-Pacer-Next` header).")
const ProjectParams = {
  project: Schema.String.annotate({
    description: "A project's name as CLIProxyPacer's Projects page shows it, its id or one of its identities.",
  }),
}
/** CLIProxyPacer's status and body unchanged, or the service's own refusal in CLIProxyPacer's error shape. */
const InspectAnswer = Schema.Unknown.annotate({
  description:
    "CLIProxyPacer's answer unchanged: its JSON, or with `format=text` its text (`X-Pacer-Next` names the next page's cursor); a refusal as `{error: {type, message}}`.",
})
const INSPECT =
  "Read only, relayed to CLIProxyPacer's `/pacer/v1/inspect/` with the install's client key, which CLIProxyPacer answers only for a key its owner lets inspect other projects. Besides the server's password, the token in a chat command's `OPENFORGE_CPP_TOKEN` opens these routes, and no other."
const inspect = (name: string, summary: string, description: string) =>
  annotations(`inspect.${name}`, summary, `${description} ${INSPECT}`)

const InspectEndpoints = [
  HttpApiEndpoint.get("pacer.inspect.projects", "/api/experimental/pacer/inspect/projects", {
    query: Schema.Struct({ all: field("`1` adds the projects that allow the key with memory off."), cursor, format }),
    success: InspectAnswer,
  }).annotateMerge(
    inspect(
      "projects",
      "List the projects this key may inspect",
      "The projects whose memory is on and whose allowed keys take the install's key, oldest first, with their counts.",
    ),
  ),
  HttpApiEndpoint.get("pacer.inspect.tasks", "/api/experimental/pacer/inspect/projects/:project/tasks", {
    params: ProjectParams,
    query: Schema.Struct({
      state: field("A task state, `work` (the default), `reviewed` or `all`."),
      query: field("1 to 10 words."),
      limit: field("1 to 50, 50 when omitted."),
      cursor,
      format,
    }),
    success: InspectAnswer,
  }).annotateMerge(
    inspect(
      "tasks",
      "List another project's tasks",
      "Its top-level tasks newest first, each with its open subtasks and those the words matched, as the task tool lists them.",
    ),
  ),
  HttpApiEndpoint.get("pacer.inspect.goals", "/api/experimental/pacer/inspect/projects/:project/goals", {
    params: ProjectParams,
    query: Schema.Struct({ all: field("`1` adds the dropped goals."), format }),
    success: InspectAnswer,
  }).annotateMerge(inspect("goals", "List another project's goals", "The board's goals with their counts.")),
  HttpApiEndpoint.get("pacer.inspect.recall", "/api/experimental/pacer/inspect/projects/:project/recall", {
    params: ProjectParams,
    query: Schema.Struct({
      q: field("1 to 2,000 characters."),
      scope: field("`all` (the default), `global`, `role:<role>` or `task:<id>`."),
      kind: field("`words`, `unverified` or `verified`, comma-separated."),
      limit: field("1 to 20, 5 when omitted."),
      cursor,
      format,
    }),
    success: InspectAnswer,
  }).annotateMerge(
    inspect(
      "recall",
      "Recall another project's memory",
      "Live entries best first, as recall finds them, without a recall row.",
    ),
  ),
  HttpApiEndpoint.get("pacer.inspect.entries", "/api/experimental/pacer/inspect/projects/:project/entries", {
    params: ProjectParams,
    query: Schema.Struct({
      role: field("Only this role's entries."),
      task: field("Only this task's entries."),
      kind: field("`words`, `unverified` or `verified`."),
      state: field("`live` (the default), `replaced`, `deleted` or `all`."),
      limit: field("1 to 100, 20 when omitted."),
      cursor,
      format,
    }),
    success: InspectAnswer,
  }).annotateMerge(inspect("entries", "List another project's entries", "Entries newest first.")),
  HttpApiEndpoint.get("pacer.inspect.items", "/api/experimental/pacer/inspect/items", {
    query: Schema.Struct({
      ids: field("1 to 20 ids of tasks, steps, goals or entries, comma-separated."),
      format,
    }),
    success: InspectAnswer,
  }).annotateMerge(
    inspect(
      "items",
      "Read tasks, goals and entries of other projects by id",
      "Each id found, under its project; the ids not found named.",
    ),
  ),
  HttpApiEndpoint.get("pacer.inspect.review", "/api/experimental/pacer/inspect/tasks/:id/review", {
    params: { id: Schema.String },
    query: Schema.Struct({ format }),
    success: InspectAnswer,
  }).annotateMerge(
    inspect(
      "review",
      "Read every review round of another project's task",
      "Its rounds oldest first, each item with its answer and every note.",
    ),
  ),
] as const

/**
 * `pacer.*`: CLIProxyPacer, through the service's one connection to it. Lives in the `server.experimental` group (see
 * `groups/experimental.ts`).
 */
export const PacerEndpoints = [
  HttpApiEndpoint.get("pacer.status", "/api/experimental/pacer/status", {
    success: Schema.Struct({ data: Pacer.Status }),
  }).annotateMerge(
    annotations(
      "status",
      "Get CLIProxyPacer status",
      "The state of the service's connection to CLIProxyPacer (not set up, unreachable, no pacer, or on), and when CLIProxyPacer last answered.",
    ),
  ),
  HttpApiEndpoint.get("pacer.accounts", "/api/experimental/pacer/accounts", {
    success: Schema.Struct({ data: Schema.NullOr(Pacer.Accounts) }),
  }).annotateMerge(
    annotations(
      "accounts",
      "List CLIProxyPacer accounts",
      "Every account the key sees, with its quota windows, as last read; null before the first read. Never waits on CLIProxyPacer.",
    ),
  ),
  HttpApiEndpoint.get("pacer.models", "/api/experimental/pacer/models", {
    success: Schema.Struct({ data: Schema.NullOr(Pacer.Models) }),
  }).annotateMerge(
    annotations(
      "models",
      "List the providers serving CLIProxyPacer models",
      "Each of CLIProxyPacer's models with the providers whose logins (not API keys) serve it, from its capabilities as last read; null while none with the pacer were read. `pacer.models.updated` follows each change. Never waits on CLIProxyPacer.",
    ),
  ),
  HttpApiEndpoint.get("pacer.chat.get", "/api/experimental/pacer/chat/:sessionID", {
    params: ChatParams,
    success: Schema.Struct({ data: Schema.NullOr(Pacer.Chat) }),
  }).annotateMerge(
    annotations(
      "chat.get",
      "Get a chat on CLIProxyPacer",
      "How CLIProxyPacer sees the chat: its account, cache, pings, next use, forced move and switches. Answers the view held from the last read at once, and never waits on CPP. When that view may be out of date (after a step of the chat, a reconnect, CPP's notices) or none is held, and the pacer is on, one read starts in the background and `pacer.chat.updated` follows if the view changed. Null while none is held, and when CPP knows nothing of the chat.",
    ),
  ),
  HttpApiEndpoint.patch("pacer.chat.update", "/api/experimental/pacer/chat/:sessionID", {
    params: ChatParams,
    payload: Pacer.ChatUpdate,
    success: Schema.Struct({ data: Pacer.Chat }),
    error: ServiceUnavailableError,
  }).annotateMerge(
    annotations(
      "chat.update",
      "Switch a chat's warming",
      "Set the chat's cache warming, compact-before-cold or compact-cold-first switch on CLIProxyPacer (the chat's own level, which wins over the key's), and return its view after the change. Unavailable unless the pacer is on.",
    ),
  ),
  HttpApiEndpoint.get("pacer.chat.requests", "/api/experimental/pacer/chat/:sessionID/requests", {
    params: ChatParams,
    query: RequestsQuery,
    success: Schema.Struct({ data: Pacer.Requests }),
    error: ServiceUnavailableError,
  }).annotateMerge(
    annotations(
      "chat.requests",
      "List a chat's CLIProxyPacer requests",
      "One page of the requests CLIProxyPacer recorded for the chat and its subagents, newest first. Read from CLIProxyPacer; unavailable unless the pacer is on.",
    ),
  ),
  HttpApiEndpoint.post("pacer.refresh", "/api/experimental/pacer/refresh", {
    success: HttpApiSchema.NoContent,
  }).annotateMerge(
    annotations(
      "refresh",
      "Read CLIProxyPacer's models again",
      "Start reading CLIProxyPacer's model list, capabilities and prices again in the background, and answer at once; while one such read runs, another call starts none. When the models changed, `model.updated` follows. Answers the same when no CPP is set up.",
    ),
  ),
  HttpApiEndpoint.get("pacer.prompt", "/api/experimental/pacer/prompt/:requestID", {
    params: { requestID: Schema.String },
    success: Schema.Struct({ data: Schema.NullOr(Pacer.PromptChange) }),
    error: ServiceUnavailableError,
  }).annotateMerge(
    annotations(
      "prompt",
      "Get what changed in a request's prompt",
      "What changed in the prompt of one request (by its CLIProxyPacer request ID) against the request CLIProxyPacer compared it with. The service keeps the last 50 it read; others are read from CPP, unavailable unless the pacer is on. Null when CPP has no such request, and at once, reading nothing, for a request that goes by its row (`row:` and CPP's row number, as a web tool call does): it sent no prompt.",
    ),
  ),
  HttpApiEndpoint.get("pacer.settings.get", "/api/experimental/pacer/settings", {
    success: Schema.Struct({ data: Pacer.Settings }),
    error: ServiceUnavailableError,
  }).annotateMerge(
    annotations(
      "settings.get",
      "Get CLIProxyPacer's compaction asks for all chats",
      "Whether CLIProxyPacer compacts cold chats first and compacts chats before they go cold, who writes the summaries and whether they keep the user's earlier messages, for all of the key's chats: its key-level settings as they apply (the key's own, else the server's, else the default). A chat's own switch wins over them. The summaries' two are absent while the service can't tell. Read from CLIProxyPacer; unavailable unless the pacer is on.",
    ),
  ),
  HttpApiEndpoint.patch("pacer.settings.update", "/api/experimental/pacer/settings", {
    payload: Pacer.SettingsUpdate,
    success: Schema.Struct({ data: Pacer.Settings }),
    error: ServiceUnavailableError,
  }).annotateMerge(
    annotations(
      "settings.update",
      "Switch CLIProxyPacer's compaction asks for all chats",
      "Set compact-cold-first, compact-before-cold, who writes the summaries or whether they keep the user's earlier messages at the key level on CLIProxyPacer, and return them as they apply after the change. A value equal to what CLIProxyPacer applies without the key level (the server's, else the default) clears the key level instead of being stored, so that a later server default reaches the key's chats. Unavailable unless the pacer is on.",
    ),
  ),
  HttpApiEndpoint.get("pacer.features", "/api/experimental/pacer/features", {
    success: Schema.Struct({ data: Pacer.Features }),
  }).annotateMerge(
    annotations(
      "features",
      "Get what CLIProxyPacer offers the TUI's commands",
      "From CLIProxyPacer's capabilities as last read: `identities`, whether it keeps agents' identities (the TUI offers `/identity` only then). All false before they are read, and without CPP. Never waits on CPP.",
    ),
  ),
  HttpApiEndpoint.get("pacer.chat.identities", "/api/experimental/pacer/chat/:sessionID/identities", {
    params: ChatParams,
    success: Schema.Struct({ data: Pacer.Identities }),
    error: [InvalidRequestError, ServiceUnavailableError, SessionNotFoundError, LocationNotFoundError],
  }).annotateMerge(
    annotations(
      "chat.identities",
      "List the agents' identities of a chat's project",
      "The identities CLIProxyPacer keeps for the chat's project, the most recently active first, and the one the chat is now. Read from CPP with the chat's project; invalid when CPP keeps no identities, the chat is in no project or CPP refuses, unavailable when CPP can't be asked.",
    ),
  ),
  HttpApiEndpoint.post("pacer.chat.identity", "/api/experimental/pacer/chat/:sessionID/identity", {
    params: ChatParams,
    payload: Pacer.IdentityLink,
    success: Schema.Struct({ data: Pacer.IdentityLinked }),
    error: [InvalidRequestError, ServiceUnavailableError, SessionNotFoundError, LocationNotFoundError],
  }).annotateMerge(
    annotations(
      "chat.identity",
      "Link a chat to an agent's identity",
      "The owner's `/identity`: from now on the chat's board actions are the named identity's (one of its project's, the one another chat is now, by its session ID, or with `new` the chat's own again), as an `identity` event on the chat's events on CLIProxyPacer. Answers the identity the chat is now. Invalid with CPP's reason in words (an unknown session or identity, another project's), unavailable when CPP can't be asked.",
    ),
  ),
  ...InspectEndpoints,
] as const
