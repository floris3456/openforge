export * as PacerSessionID from "./session-id.js"

import { createHash } from "node:crypto"
import type { SessionID } from "@opencode/schema/session-id"

/** openforge's fixed UUID v5 namespace for CLIProxyPacer chat IDs. Changing it renames every chat on CPP. */
export const namespace = "25d56e25-f22e-4ada-ad98-ba61ea70f729"

const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex")

/**
 * The chat ID CPP knows an openforge session by (`X-Pacer-Session`): the RFC 4122 UUID v5 of the session ID under
 * {@link namespace}, lowercase. CPP names a UUID back exactly as sent, so its answers and `compact` notices map to the
 * session without a lookup, and nothing new is stored.
 */
export function make(sessionID: SessionID) {
  const known = uuids.get(sessionID)
  if (known) {
    sessions.delete(known)
    sessions.set(known, sessionID)
    return known
  }
  const made = uuid(sessionID)
  uuids.set(sessionID, made)
  sessions.set(made, sessionID)
  if (sessions.size > KEPT) {
    const oldest = sessions.keys().next().value!
    uuids.delete(sessions.get(oldest)!)
    sessions.delete(oldest)
  }
  return made
}

/** The chats this process named lately; past it the oldest goes. */
export const KEPT = 1_000
const uuids = new Map<SessionID, string>()
const sessions = new Map<string, SessionID>()

/** The session a UUID {@link make} gave lately names; none for one it has not, or no longer keeps. */
export function session(uuid: string) {
  return sessions.get(uuid)
}

function uuid(sessionID: SessionID) {
  // node:crypto rather than Bun.randomUUIDv5: core also runs on Node and workerd.
  const hash = createHash("sha1").update(namespaceBytes).update(sessionID, "utf8").digest()
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6)
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
