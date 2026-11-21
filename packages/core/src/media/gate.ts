export * as MediaGate from "./gate.js"

import type { Effect } from "effect"

// openforge (task ze433w6fask0): how the work on a database's rows (MediaMove, MediaExpiry) waits for the service that
// owns the database.

export interface Interface {
  /** Runs before each chat or row, so that the service can hold the work while it is paused. */
  readonly between: Effect.Effect<void>
  /**
   * Wraps each of its writes. On a connection of its own (MediaWorker), a write must never run beside the service's
   * statements: a transaction of the service's that read before the write committed would fail on its own next write
   * with SQLITE_BUSY_SNAPSHOT, which no busy timeout waits out.
   */
  readonly write: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>
}

/** On the service's own connection, where every statement waits its turn anyway. */
export const here = (between: Effect.Effect<void>): Interface => ({ between, write: (effect) => effect })
