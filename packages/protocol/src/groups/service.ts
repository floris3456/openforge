import { Continuity } from "@opencode/schema/continuity"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.service.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

const PausePayload = Schema.Struct({
  /** Milliseconds to wait for every execution to rest before giving up; 2 minutes by default. */
  timeout: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
}).annotate({ identifier: "Continuity.PausePayload" })

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const ServiceEndpoints = [
  HttpApiEndpoint.get("service.status", "/api/experimental/service/status", {
    success: Schema.Struct({ data: Continuity.Status }),
  }).annotateMerge(
    annotations(
      "status",
      "Get service pause state",
      "Whether the service is running, pausing or paused, what a pause still waits for, and which executions rest.",
    ),
  ),
  HttpApiEndpoint.post("service.pause", "/api/experimental/service/pause", {
    payload: PausePayload,
    success: Schema.Struct({ data: Continuity.PauseResult }),
  }).annotateMerge(
    annotations(
      "pause",
      "Pause the service",
      "Stop starting model calls and in-service tools, and answer once every execution rests at a step boundary or in a wait that survives a stop, recorded in the database. Prompts and answers are still accepted. If that takes longer than the timeout, the pause is lifted and the answer lists what was still running.",
    ),
  ),
  HttpApiEndpoint.post("service.resume", "/api/experimental/service/resume", {
    success: Schema.Struct({ data: Continuity.Status }),
  }).annotateMerge(
    annotations(
      "resume",
      "Resume the service",
      "Lift a pause, or end a paused start: writes are accepted again and every resting execution continues where it rested.",
    ),
  ),
] as const
