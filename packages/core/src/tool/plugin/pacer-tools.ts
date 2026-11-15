export * as PacerToolsPlugin from "./pacer-tools.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { isRecord } from "@opencode/util/record"
import { Effect, Stream } from "effect"
import { MemoryTask } from "../../memory/task.js"
import { PacerProject } from "../../pacer/project.js"
import { PacerTools } from "../../pacer/tools.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"

// Every tool CPP lists, as built-in tools: one direct tool per name its lists named at the current endpoint
// (`PacerTools.known`, kept across restarts, so a step resumed right after one sends the tools it had), each asking
// the permission its meta names. Nothing here knows any of them: CPP holds their definitions, rules and texts (the
// workspace's spec `docs/specs/cpp-tools.md`). Their definitions here never reach a model: each request puts the
// chat's own from CPP in their place, or leaves them out (`PacerOffer`).

/** CPP's definitions, from the chat's list, replace these on every request. */
const placeholder = "One of CLIProxyPacer's tools; each request carries CLIProxyPacer's own definition instead."

export const Plugin = {
  id: "opencode.tool.pacer-tools",
  effect: Effect.fn("PacerToolsPlugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const calls = yield* PacerTools.Service
    const sessions = yield* Session.Service
    const projects = yield* PacerProject.Service

    const state = { known: yield* calls.known() }
    yield* calls.knownChanges().pipe(
      Stream.runForEach((known) => {
        if (known === state.known) return Effect.void
        state.known = known
        return ctx.tool.reload()
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) => {
        for (const [name, meta] of state.known)
          editor.add({
            name,
            options: { codemode: false, permission: meta.permission },
            description: placeholder,
            input: { type: "object" },
            execute: (input, context) =>
              Effect.gen(function* () {
                const args = isRecord(input) ? input : {}
                yield* permission
                  .assert({
                    action: meta.permission,
                    resources: subject(args, meta.subject),
                    save: ["*"],
                    metadata: args,
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
                // A subagent's calls are rows of its own chat, nested under its parent's, as its model requests are.
                const session = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                const project = session ? (yield* projects.chat(session.projectID)).headers : undefined
                const answer = yield* calls
                  .call({
                    sessionID: context.sessionID,
                    parentID: session?.parentID,
                    project,
                    agent: String(context.agent),
                    name,
                    args: input,
                  })
                  // Not as the failure's cause, which would make it an unknown error rather than the tool's.
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                // CPP keeps the chat's place; openforge's own hooks read it from the session's metadata.
                if (session && answer.place !== undefined) {
                  const place = MemoryTask.fromPlace(answer.place)
                  if (!MemoryTask.at(session.metadata, place))
                    yield* sessions
                      .setMetadata({ sessionID: session.id, metadata: MemoryTask.placed(session.metadata, place) })
                      .pipe(Effect.ignore)
                }
                // A failed call is still CPP's answer, whose text tells the model what to do.
                if (answer.error)
                  return yield* new ToolFailure({
                    message: answer.text || answer.error.message,
                    metadata: answer.metadata,
                  })
                return { content: answer.text, metadata: answer.metadata }
              }),
          })
      })
      .pipe(Effect.orDie)
  }),
}

/** The values of the first subject argument the call holds, a string or a list's strings; `*` when it holds none. */
function subject(args: Readonly<Record<string, unknown>>, names: ReadonlyArray<string>) {
  const found = names.find((name) => args[name] !== undefined)
  const value = found === undefined ? undefined : args[found]
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
  return values.length > 0 ? values : ["*"]
}
