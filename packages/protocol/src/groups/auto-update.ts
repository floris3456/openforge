import { AutoUpdate } from "@opencode/schema/auto-update"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.update.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

/** `update.*`: automatic updates of this service (spec auto-update). Lives in the `server.experimental` group. */
export const AutoUpdateEndpoints = [
  HttpApiEndpoint.get("update.get", "/api/experimental/update", {
    success: Schema.Struct({ data: AutoUpdate.Status }),
  }).annotateMerge(
    annotations(
      "get",
      "Get automatic updates",
      "Whether this service installs new releases by itself (the global config's `update` is `auto`), why it can't when it can't, and the last automatic update that failed.",
    ),
  ),
  HttpApiEndpoint.put("update.set", "/api/experimental/update", {
    payload: AutoUpdate.Update,
    success: Schema.Struct({ data: AutoUpdate.Status }),
  }).annotateMerge(
    annotations(
      "set",
      "Turn automatic updates on or off",
      "Write the global config's `update`: `auto` when on, `notify` when off. It applies at once: on checks for a new release now and every 15 minutes, off checks nothing.",
    ),
  ),
] as const
