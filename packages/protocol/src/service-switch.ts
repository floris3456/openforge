export * as ServiceSwitch from "./service-switch.js"

// How the background service answers while openforge switches releases, shared by the service and the clients that
// resend writes through a switch. Plain constants that import nothing, so the client's promise build can use them
// without Effect.

/** The service's own endpoints (status, pause, resume): a paused start answers them, and a client never resends them. */
export const path = "/api/experimental/service/"

/** The methods a paused start answers. It refuses every other request outside `path` with `refused`. */
export const reads: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * What a service that started paused answers a write with (status 503, `retry-after: 1`) until it is resumed, so a
 * rollback to the previous release cannot lose the write. A client resends it.
 */
export const refused = { code: "service_switching", message: "switching, try again in 1 s" } as const

/** The codes of the 503 a service answers with while it starts and while it stops. A client resends those too. */
export const starting = "service_starting"
export const stopping = "service_stopping"
