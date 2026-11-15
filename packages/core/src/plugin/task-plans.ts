export * as TaskPlansPlugin from "./task-plans.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionIdleBackground } from "@opencode/plugin/effect/session"
import type { Session } from "@opencode/schema/session"
import { Cause, Effect } from "effect"
import { MemoryPlans } from "../memory/plans.js"
import { MemoryTask } from "../memory/task.js"
import { EditTool } from "../tool/plugin/edit.js"
import { PatchTool } from "../tool/plugin/patch.js"
import { ShellTool } from "../tool/plugin/shell.js"
import { WriteTool } from "../tool/plugin/write.js"

// Where task plans are enforced (the workspace's spec `docs/specs/task-plans.md`, sections 6 and 8), in a chat that
// works under them (`MemoryPlans.planned`): an edit, write or patch in no task is refused before it runs, and a turn
// inside a task that changed something without a task call ends with one check. A shell command cannot be told apart
// as reading or changing, so it is never refused; it counts for the check.

/** The tools that change files, refused in a chat in no task. */
const changing: ReadonlySet<string> = new Set([EditTool.name, WriteTool.name, PatchTool.name])
/** The calls that make a turn one that changed something. */
const worked: ReadonlySet<string> = new Set([...changing, ShellTool.name])
/** The check's mark in its message's metadata: one per turn. */
export const SOURCE = "task-check"

export const Plugin = {
  id: "opencode.task-plans",
  effect: Effect.fn("TaskPlansPlugin")(function* (ctx: Context) {
    const plans = yield* MemoryPlans.Service
    // Whether a chat called a tool that changes something since its last check, as this process saw its calls. The
    // check reads the chat only then: a read at the end of every turn waits behind every other chat's writes on the
    // one database connection (the load check of 0.0.40: with 50 chats at once, the 95th percentile turn +24 %). A
    // chat this process has not seen call a tool, one a restart resumed for instance, is checked as before.
    const changed = new Map<Session.ID, boolean>()

    /** Why the call is refused, or undefined when it runs. */
    const refusal = Effect.fnUntraced(function* (tool: string, sessionID: Session.ID) {
      if (!changing.has(tool)) return undefined
      const session = yield* ctx.session.get({ sessionID })
      if (MemoryTask.inside(session.metadata)) return undefined
      if (!(yield* plans.planned(session))) return undefined
      // A chat that cannot make a task now is not kept from editing.
      if (!(yield* plans.reachable(session))) return undefined
      return MemoryPlans.refused
    })

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        changed.set(event.sessionID, changed.get(event.sessionID) === true || worked.has(event.tool))
        // The guard is never a condition of the call: a failure here lets it run.
        const refused = yield* refusal(event.tool, event.sessionID).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("task plans could not tell whether a call is in a task", {
                  sessionID: event.sessionID,
                  cause,
                }).pipe(Effect.as(undefined)),
          ),
        )
        if (refused) return yield* new ToolFailure({ message: refused })
      }),
    )

    // Claude Code's `Stop` hook with exit code 2, built in: the runner fires this once the chat would go idle with
    // nothing pending, and the message admitted here gives the model one more step instead. It goes at the end of the
    // chat, where the prompt cache is not touched.
    const check = Effect.fn("TaskPlansPlugin.check")(function* (
      sessionID: Session.ID,
      background: ReadonlyArray<SessionIdleBackground>,
    ) {
      // The chat's own subagent, shell or image job wakes it with its notice, and the hook runs again then.
      if (background.some((work) => work.sessionID === sessionID)) return
      if (changed.get(sessionID) === false) return
      changed.set(sessionID, false)
      const session = yield* ctx.session.get({ sessionID })
      const inside = MemoryTask.inside(session.metadata)
      if (!inside) return
      if (!(yield* plans.planned(session))) return
      // The turn: everything since the chat's newest prompt, or all it has in view when a compaction took that out.
      const messages = yield* ctx.session.context({ sessionID })
      const turn = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1)
      if (turn.some((message) => message.type === "synthetic" && message.metadata?.source === SOURCE)) return
      const calls = turn.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool" ? [part.name] : []))
          : [],
      )
      if (calls.includes("task") || !calls.some((name) => worked.has(name))) return
      const item = yield* plans.current(session, inside)
      if (item?.state !== "active") return
      // A child asks only for what the task tool lets it set: the task or step it is inside, or a step it made. A step
      // of its lead's that it is not on is its lead's to set (the overnight tests of 2026-11-15: the check asked for a
      // review the tool refused, in 2 of 3 subagent runs).
      if (
        session.parentID !== undefined &&
        item.id !== inside.task &&
        item.id !== inside.subtask &&
        !(item.parent && item.by.chat === session.id)
      )
        return
      yield* ctx.session.synthetic({
        sessionID,
        text: MemoryPlans.check(item, session),
        description: "Task check",
        metadata: { source: SOURCE },
      })
    })

    yield* ctx.session.hook("experimental.idle", (event) =>
      check(event.sessionID, event.background).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("the task check failed", { sessionID: event.sessionID, cause }),
        ),
      ),
    )
  }),
}
