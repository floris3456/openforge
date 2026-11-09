import type { Data } from "@opencode/plugin/tui/context"
import { Attention } from "@opencode/schema/attention"
import { Schema } from "effect"
import type { AttentionRequest } from "./attention"
import type { AttentionEventSound, Resolved, ResolvedAttentionEvent } from "./config"

// openforge (notifications step 2): the events a TUI raises, each with its own notification switch and sound
// (`attention.events`), as OpenCodePlus 1.3.18 had them.
//
// - Done: a top-level chat's turn succeeded and nothing it started still runs: no subagent at any depth, no shell of
//   it or of its subagents.
// - Reply: a top-level chat's turn succeeded while such work runs. A reply that is Done raises only Done; with Done
//   off, it raises Reply.
// - Subagent done: a subagent's turn succeeded, at most `levels` below its chat, by the same rule as Done.
// - Question: a question, form or permission that waits, at any depth.
// - Error: a failed turn of a top-level chat, or of a subagent within `levels` while Subagent done is on.
//
// An interrupted turn raises nothing.

type Shell = { readonly status: string; readonly metadata: Readonly<Record<string, unknown>> }
type Location = { readonly directory: string }

export function createAttentionEvents(input: {
  readonly data: Pick<Data, "on"> & {
    readonly session: Pick<Data["session"], "get" | "sync" | "family" | "status">
  }
  /** The running shells of a location. */
  readonly shells: (location: Location | undefined) => Promise<readonly Shell[]>
  readonly settings: () => Resolved["attention"]
  readonly raise: (request: AttentionRequest) => Promise<unknown>
  /** Whether the TUI raises this chat's events at all (its own chats), so nothing is asked about any other. */
  readonly ours: (sessionID: string) => Promise<boolean>
  /** A failed turn's toast, as upstream shows it. */
  readonly failed: (sessionID: string, message: string) => void
}) {
  const session = input.data.session
  // A session whose turn ended, until its next one starts: an execution ends once.
  const ended = new Set<string>()
  const turns = new Map<string, number>()
  const forms = new Set<string>()
  const permissions = new Set<string>()

  const raise = (
    event: ResolvedAttentionEvent,
    sound: AttentionEventSound,
    request: Pick<AttentionRequest, "kind" | "sessionID" | "title" | "message">,
  ) => {
    if (!on({ notification: event.notification, sound })) return
    void input.raise({
      ...request,
      notification: event.notification ? "blurred" : false,
      sound: soundOf(sound),
    })
  }

  const succeeded = async (sessionID: string) => {
    const turn = turns.get(sessionID)
    const events = input.settings().events
    const level = await depth(session, sessionID)
    const title = session.get(sessionID)?.title
    if (level === 0) {
      if (!on(events.done) && !on(events.reply)) return
      if (!(await input.ours(sessionID))) return
      const done = on(events.done) && !(await busy(sessionID)) && turns.get(sessionID) === turn
      if (done)
        return raise(events.done, events.done.sound, { kind: "done", sessionID, title, message: "Session done" })
      return raise(events.reply, events.reply.sound, { kind: "reply", sessionID, title, message: "Session replied" })
    }
    if (!on(events.subagent_done) || level > events.subagent_done.levels) return
    if (!(await input.ours(sessionID))) return
    if ((await busy(sessionID)) || turns.get(sessionID) !== turn) return
    raise(events.subagent_done, events.subagent_done.sound, {
      kind: "subagent_done",
      sessionID,
      title,
      message: "Subagent done",
    })
  }

  const failed = async (sessionID: string, message: string) => {
    const events = input.settings().events
    const level = await depth(session, sessionID)
    if (level > 0 && (!on(events.subagent_done) || level > events.subagent_done.levels)) return
    raise(events.error, events.error.sound, { kind: "error", sessionID, title: session.get(sessionID)?.title, message })
  }

  // Work the session started that still runs: a subagent at any depth, or a shell of it or of one of its subagents.
  const busy = async (sessionID: string) => {
    const family = descendants(session, sessionID)
    if (family.some((id) => session.status(id) === "running")) return true
    const mine = new Set([sessionID, ...family])
    const shells = await input.shells(session.get(sessionID)?.location).catch(() => [])
    return shells.some((shell) => shell.status === "running" && mine.has(String(shell.metadata.sessionID)))
  }

  const dispose = [
    input.data.on("form.created", (event) => {
      const form = event.data.form
      if (forms.has(form.id)) return
      forms.add(form.id)
      const question = input.settings().events.question
      raise(question, question.sound, {
        kind: "question",
        sessionID: form.sessionID,
        title: form.title,
        message: "Input needs response",
      })
    }),
    input.data.on("form.replied", (event) => forms.delete(event.data.id)),
    input.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
    input.data.on("permission.asked", (event) => {
      if (permissions.has(event.data.id)) return
      permissions.add(event.data.id)
      const question = input.settings().events.question
      raise(question, question.permission, {
        kind: "permission",
        sessionID: event.data.sessionID,
        title: session.get(event.data.sessionID)?.title,
        message: "Permission needs input",
      })
    }),
    input.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
    input.data.on("session.execution.started", (event) => {
      ended.delete(event.data.sessionID)
      turns.set(event.data.sessionID, (turns.get(event.data.sessionID) ?? 0) + 1)
    }),
    input.data.on("session.execution.succeeded", (event) => {
      if (ended.has(event.data.sessionID)) return
      ended.add(event.data.sessionID)
      void succeeded(event.data.sessionID)
    }),
    input.data.on("session.execution.interrupted", (event) => void ended.add(event.data.sessionID)),
    input.data.on("session.execution.failed", (event) => {
      const sessionID = event.data.sessionID
      if (ended.has(sessionID)) return
      ended.add(sessionID)
      // The free-tier and Go limits raise nothing, as upstream.
      if (event.data.error.type === "provider.free-limit" || event.data.error.type === "provider.go-limit") return
      input.failed(sessionID, event.data.error.message)
      void failed(sessionID, event.data.error.message)
    }),
  ]
  return () => dispose.reverse().forEach((cleanup) => cleanup())
}

/** An event does something: it notifies or it has a sound. */
export function on(event: { readonly notification: boolean; readonly sound: AttentionEventSound }) {
  return event.notification || event.sound !== "off"
}

/** The sound to raise: none, a built-in one by its ID, or a file. */
export function soundOf(sound: AttentionEventSound): AttentionRequest["sound"] {
  if (sound === "off") return false
  if (Schema.is(Attention.SoundID)(sound)) return { when: "always", id: sound }
  return { when: "always", file: sound }
}

type Sessions = Pick<Data["session"], "get" | "sync" | "family">

// How far below its top-level chat a session is (0: the chat itself), loading a parent the TUI doesn't have yet.
async function depth(
  session: Pick<Sessions, "get" | "sync">,
  sessionID: string,
  seen = new Set<string>(),
): Promise<number> {
  seen.add(sessionID)
  const info =
    session.get(sessionID) ??
    (await session.sync(sessionID).then(
      () => session.get(sessionID),
      () => undefined,
    ))
  if (!info?.parentID || seen.has(info.parentID)) return 0
  return 1 + (await depth(session, info.parentID, seen))
}

// The sessions below this one at any depth, of those the TUI knows.
function descendants(session: Pick<Sessions, "get" | "family">, sessionID: string) {
  const below = (id: string, seen: Set<string>): boolean => {
    const parentID = session.get(id)?.parentID
    if (parentID === undefined || seen.has(parentID)) return false
    return parentID === sessionID || below(parentID, seen.add(parentID))
  }
  return session.family(sessionID).filter((id) => id !== sessionID && below(id, new Set([id])))
}
