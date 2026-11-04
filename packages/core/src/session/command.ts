export * as SessionCommand from "./command.js"

import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Clock, Effect } from "effect"
import { Command } from "../command.js"
import { Instance } from "../instance/service.js"
import { KV } from "../kv.js"
import { Plugin } from "../plugin/service.js"

export const execute = Effect.fn("SessionCommand.execute")(function* (input: {
  session: Session.Info
  command: string
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  delivery?: SessionInbox.Delivery
}) {
  const instances = yield* Instance.Service
  yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const commands = yield* Command.Service
    yield* commands.execute({
      name: input.command,
      invocation: {
        sessionID: input.session.id,
        prompt: {
          text: input.text,
          files: input.files,
          agents: input.agents,
          skills: input.skills,
        },
        delivery: input.delivery ?? "steer",
      },
    })
  }).pipe(instances.provide(input.session))
})

const PREFIX = "session.command/"
// Longer than a client resends a write, which is 2 minutes.
const KEPT = 10 * 60_000

/**
 * Runs a command given an id once: the same id again does nothing. A client sends a command again with its id when
 * the connection dropped after the request went out, as when a release switch stops the service that may have taken
 * it. Ids are kept for 10 minutes, in the database the next release starts from.
 */
export function once<E, R>(id: string | undefined, run: Effect.Effect<void, E, R>) {
  return Effect.gen(function* () {
    if (id === undefined) return yield* run
    const kv = yield* KV.Service
    if ((yield* kv.get(PREFIX + id)) !== undefined) return
    yield* run
    const now = yield* Clock.currentTimeMillis
    yield* kv.set(PREFIX + id, { at: now })
    const kept = yield* kv.scan({ prefix: PREFIX, limit: 1000 })
    yield* Effect.forEach(
      kept.entries.filter(
        (entry) => !(isRecord(entry.value) && typeof entry.value.at === "number" && entry.value.at > now - KEPT),
      ),
      (entry) => kv.remove(entry.key),
      { discard: true },
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
