import type { AttentionNotifyOptions, AttentionNotifySkipReason } from "@opencode/plugin/tui/context"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"

// openforge: which notifications a TUI raises. A TUI follows the events of every chat of its service, so it raises
// only those of its own chats: the chats in its tabs and the one it shows, with their subagents at any depth. A
// permission it accepts itself (`session.permissions: autoaccept`) raises nothing.

type Sessions = {
  get(sessionID: string): { readonly parentID?: string } | undefined
  sync(sessionID: string): Promise<void>
}

export function createChatFilter(input: {
  session: Sessions
  /** The chats this TUI has open, each by its top session: its tabs and the one it shows. */
  open: () => readonly string[]
  /** Whether this TUI accepts this chat's permissions itself. */
  autoReplied: (sessionID: string) => boolean
}) {
  return async (request: AttentionNotifyOptions): Promise<AttentionNotifySkipReason | undefined> => {
    // A request about no chat, or about something else (a form no chat asked for), passes as before.
    if (!Schema.is(SessionID)(request.sessionID)) return
    const sessionID = request.sessionID
    if (soundName(request) === "permission" && input.autoReplied(sessionID)) return "permission_answered"
    if (!input.open().includes(await rootOf(input.session, sessionID))) return "session_not_open"
  }
}

const soundName = (request: AttentionNotifyOptions) => (typeof request.sound === "object" ? request.sound.name : undefined)

// The chat a session belongs to: up its parents, loading a session whose info this TUI doesn't have yet (a subagent
// that started before the TUI did).
async function rootOf(session: Sessions, sessionID: string, seen = new Set<string>()): Promise<string> {
  seen.add(sessionID)
  const info =
    session.get(sessionID) ??
    (await session.sync(sessionID).then(
      () => session.get(sessionID),
      () => undefined,
    ))
  if (!info?.parentID || seen.has(info.parentID)) return sessionID
  return rootOf(session, info.parentID, seen)
}
