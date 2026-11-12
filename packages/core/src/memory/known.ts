export * as MemoryKnown from "./known.js"

import { Effect } from "effect"
import type { KV } from "../kv.js"
import type { PacerEndpoint } from "../pacer/endpoint.js"
import type { PacerModels } from "../pacer/models.js"

// Whether a server had memory when its catalog was last read, kept across restarts. While a catalog is not read yet
// (the moments after a start, when long chats resume), this decides whether the memory tools are offered: a tool list
// that changes one step later misses the provider's prompt cache for the rest of the chat. Keyed by the endpoint's
// root, so one server's answer never stands for another's.

export const key = (endpoint: PacerEndpoint.Endpoint) => `pacer:memory:${endpoint.root}`

/** Whether `endpoint` had memory at its last read catalog; false when never known. */
export const read = (kv: KV.Interface, endpoint: PacerEndpoint.Endpoint) =>
  kv.get(key(endpoint)).pipe(Effect.map((value) => value === true))

/** Stores what a read catalog says of `endpoint`, the one it was read from. */
export const write = (kv: KV.Interface, endpoint: PacerEndpoint.Endpoint, catalog: PacerModels.Catalog) =>
  kv.set(key(endpoint), catalog.pacer?.memory !== undefined)
