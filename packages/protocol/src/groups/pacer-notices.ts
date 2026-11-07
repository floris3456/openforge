import { Pacer } from "@opencode/schema/pacer"
import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/http-api"
import { annotations } from "./pacer.js"

/**
 * `pacer.notices.*`: CLIProxyPacer's cache notices, which the service holds for every TUI (spec
 * cliproxypacer-cache-notices). Lives in the `server.experimental` group (see `groups/experimental.ts`).
 */
export const PacerNoticeEndpoints = [
  HttpApiEndpoint.get("pacer.notices.list", "/api/experimental/pacer/notices", {
    success: Schema.Struct({ data: Schema.Array(Pacer.Notice) }),
  }).annotateMerge(
    annotations(
      "notices.list",
      "List cache notices",
      "Every cache miss or partial reuse of a step or a compaction of this service's chats on CLIProxyPacer, a subagent's included, but for the expected losses (CLIProxyPacer's causes `expired` and `compaction`), that nobody dismissed: newest first, at most 50, none older than 2 hours. Held in memory, so a restart of the service starts with none. Never waits on CLIProxyPacer; `pacer.notice.added` tells each new one.",
    ),
  ),
  HttpApiEndpoint.post("pacer.notices.dismiss", "/api/experimental/pacer/notices/:requestID/dismiss", {
    params: { requestID: Schema.String },
    success: Schema.Struct({ data: Schema.Literal(true) }),
  }).annotateMerge(
    annotations(
      "notices.dismiss",
      "Dismiss a cache notice",
      "Dismiss the cache notice of one request (by its request ID) in every TUI: `pacer.notice.dismissed` tells them. Answers true, also for a request with no notice held.",
    ),
  ),
] as const
