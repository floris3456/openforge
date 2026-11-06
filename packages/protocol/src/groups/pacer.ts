import { Pacer } from "@opencode/schema/pacer"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { ServiceUnavailableError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
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
      "The state of the service's connection to CLIProxyPacer (not set up, unreachable, no pacer, or on), and when CPP last answered.",
    ),
  ),
  HttpApiEndpoint.get("pacer.accounts", "/api/experimental/pacer/accounts", {
    success: Schema.Struct({ data: Schema.NullOr(Pacer.Accounts) }),
  }).annotateMerge(
    annotations(
      "accounts",
      "List CLIProxyPacer accounts",
      "Every account the key sees, with its quota windows, as last read; null before the first read. Never waits on CPP.",
    ),
  ),
  HttpApiEndpoint.get("pacer.chat.get", "/api/experimental/pacer/chat/:sessionID", {
    params: ChatParams,
    success: Schema.Struct({ data: Schema.NullOr(Pacer.Chat) }),
  }).annotateMerge(
    annotations(
      "chat.get",
      "Get a chat on CLIProxyPacer",
      "How CPP sees the chat: its account, cache, pings, next use, forced move and switches. Read from CPP only when the last read is out of date and the pacer is on, else as last read; null when CPP knows nothing of the chat.",
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
      "Set the chat's cache warming or compact-before-cold switch on CPP, and return its view after the change. Unavailable unless the pacer is on.",
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
      "One page of the requests CPP recorded for the chat and its subagents, newest first. Read from CPP; unavailable unless the pacer is on.",
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
      "What changed in the prompt of one request (by its CPP request ID) against the request CPP compared it with. The service keeps the last 50 it read; others are read from CPP, unavailable unless the pacer is on. Null when CPP has no such request.",
    ),
  ),
] as const
