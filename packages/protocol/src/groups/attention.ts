import { Attention } from "@opencode/schema/attention"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.attention.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

const FollowQuery = Schema.Struct({
  /** The player also shows desktop notifications, so the TUIs leave theirs to it. */
  desktop: BooleanFromString.pipe(Schema.optional),
}).annotate({ identifier: "Attention.FollowQuery" })

const TestPayload = Schema.Struct({ kind: Schema.Literals(Attention.testKinds) }).annotate({
  identifier: "Attention.TestPayload",
})

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const AttentionEndpoints = [
  HttpApiEndpoint.post("attention.occurrence", "/api/experimental/attention/occurrence", {
    payload: Attention.Occurrence,
    success: Schema.Struct({ data: Attention.Players }),
  }).annotateMerge(
    annotations(
      "occurrence",
      "Report a notification",
      "A TUI reports a notification it shows. The service passes it on to the players that follow it and answers which kinds of player are connected, so the TUI leaves the sound, or also the desktop notification, to them.",
    ),
  ),
  HttpApiEndpoint.get("attention.follow", "/api/experimental/attention/follow", {
    query: FollowQuery,
    success: HttpApiSchema.StreamSse({ data: Attention.FollowEvent }),
  }).annotateMerge(
    annotations(
      "follow",
      "Follow notifications",
      "A player (`openforge notify`) follows the notifications this service's TUIs report. It counts as connected for as long as the stream is open.",
    ),
  ),
  HttpApiEndpoint.post("attention.test", "/api/experimental/attention/test", {
    payload: TestPayload,
    success: Schema.Struct({ data: Attention.Players }),
  }).annotateMerge(
    annotations(
      "test",
      "Send a test notification",
      "Pass a test notification of this kind on to the connected players, and answer which kinds of player are connected.",
    ),
  ),
] as const
