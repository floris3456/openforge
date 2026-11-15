export * as MemoryKnown from "./known.js"

import { Effect } from "effect"
import type { KV } from "../kv.js"
import type { PacerEndpoint } from "../pacer/endpoint.js"
import type { PacerModels } from "../pacer/models.js"

// Whether a server served memory's tools when its catalog was last read, kept across restarts. While a catalog is not
// read yet (the moments after a start, when long chats resume), this decides whether a start block is asked for. Keyed
// by the set-up address's root, so one server's answer never stands for another's, while each address of its pair is
// the same CPP.

export const key = (endpoint: PacerEndpoint.Endpoint) => `pacer:memory-tools:${endpoint.home ?? endpoint.root}`

/** Whether `endpoint` served memory's tools at its last read catalog; false when never known. */
export const read = (kv: KV.Interface, endpoint: PacerEndpoint.Endpoint) =>
  kv.get(key(endpoint)).pipe(Effect.map((value) => value === true))

/** Stores what a read catalog says of `endpoint`, the one it was read from. */
export const write = (kv: KV.Interface, endpoint: PacerEndpoint.Endpoint, catalog: PacerModels.Catalog) =>
  kv.set(key(endpoint), catalog.pacer?.memory?.tools === true)
