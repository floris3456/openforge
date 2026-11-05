export * as PacerModels from "./models.js"

import { Context, type Effect, type Stream } from "effect"

// The seam between the CLIProxyPacer provider and the service's connection to CPP. The provider's side builds the
// catalog and owns every read of `/v1/models`, `/pacer/v1/capabilities` and `/pacer/v1/models`; the connection asks
// it to read again when CPP's change stream says so (`capabilities`, `settings`, `price`, `resync`, a reconnect) and
// takes "no pacer" from it. Fields may be added; none may be removed or renamed without both sides.

/** What capabilities' `pacer` block says the server does; null for a proxy without the pacer. */
export interface Pacer {
  /** `pacer.compact_tokens`: the `X-Pacer-Compact` tokens the server reads. */
  readonly compactTokens: ReadonlyArray<string>
}

export interface Model {
  /** CPP's model ID, as `/v1/models` lists it. */
  readonly id: string
}

/** CPP's models as last read. */
export interface Catalog {
  /** When it was read, on the local clock (Unix ms). */
  readonly at: number
  /** Null when the proxy has no pacer: capabilities answered 404, was refused, or said `pacer: null`. */
  readonly pacer: Pacer | null
  readonly models: ReadonlyArray<Model>
}

export interface Interface {
  /** The catalog as last read; undefined while CPP is not set up or before the first read succeeded. */
  readonly get: () => Effect.Effect<Catalog | undefined>
  /** The catalog now, then each change of it. */
  readonly changes: () => Stream.Stream<Catalog | undefined>
  /** Reads everything again now. A failed read keeps the last catalog. */
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerModels") {}
