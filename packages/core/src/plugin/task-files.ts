export * as TaskFilesPlugin from "./task-files.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { isRecord } from "@opencode/util/record"
import { Cause, Clock, Effect } from "effect"
import { MemoryClient } from "../memory/client.js"
import { MemoryTask } from "../memory/task.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { normalizeContent } from "../tool/runtime.js"
import { EditTool } from "../tool/plugin/edit.js"
import { PatchTool } from "../tool/plugin/patch.js"
import { WriteTool } from "../tool/plugin/write.js"

// The files report (workspace reference `docs/reference/task-system-later-api.md`, "Edited files and the clash notice"):
// after each successful edit, write or patch in a chat whose latest step went through CLIProxyPacer, on a server with
// memory `later`, while the chat is inside a task (its metadata's place), openforge tells CPP the paths the call changed,
// as the tool wrote them. CPP keeps them for the chat's task and may answer a clash notice, which goes at the end of the
// tool's result, so the chat's history keeps it. The edit waits for the answer at most `LIMIT`; a timeout or failure
// adds nothing and is only logged.

/** How long an edit waits for the report's answer. */
export const LIMIT = "500 millis"
/** Chats held whose latest step went through CPP; past it the oldest goes. */
export const CHATS = 1_000
/** At most this many paths a report, each at most `PATH` characters. */
export const PATHS = 50
export const PATH = 500

const provider: string = PacerEndpoint.id

/** The paths a successful call of one of openforge's edit tools changed, as its output names them. */
export function paths(tool: string, output: unknown): string[] {
  if (!isRecord(output)) return []
  const items = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : [])
  const found =
    tool === EditTool.name
      ? items(output.files).map((file) => file.file)
      : tool === WriteTool.name
        ? [output.resource]
        : tool === PatchTool.name
          ? items(output.applied).map((item) => item.resource)
          : []
  return [
    ...new Set(found.filter((item): item is string => typeof item === "string" && item !== "" && item.length <= PATH)),
  ].slice(0, PATHS)
}

export const Plugin = {
  id: "opencode.task-files",
  effect: Effect.fn("TaskFilesPlugin")(function* (ctx: Context) {
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    // The chats whose latest model request went through CPP, as this process saw them.
    const through = new Set<Session.ID>()

    yield* ctx.session.hook("model.request", (event) =>
      Effect.sync(() => {
        if (event.kind !== "primary") return
        through.delete(event.sessionID)
        if (event.model.providerID !== provider) return
        through.add(event.sessionID)
        if (through.size > CHATS) through.delete(through.values().next().value!)
      }),
    )

    /** CPP's notice for the call's paths, or null. */
    const report = Effect.fnUntraced(function* (sessionID: Session.ID, agent: string, changed: ReadonlyArray<string>) {
      if ((yield* catalogs.get())?.pacer?.memory?.later !== true) return null
      const session = yield* ctx.session.get({ sessionID })
      if (!MemoryTask.inside(session.metadata)) return null
      const named = yield* projects.chat(session.projectID)
      if (named.project === undefined) return null
      const at = yield* Clock.currentTimeMillis
      return yield* client
        .withHeaders(PacerHeaders.chat({ sessionID, parentID: session.parentID, project: named.headers, agent }))
        .files(named.project, { paths: changed, at }, { timeout: LIMIT })
    })

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed" || !through.has(event.sessionID)) return
        const changed = paths(event.tool, event.result.output)
        if (changed.length === 0) return
        const notice = yield* report(event.sessionID, String(event.agent), changed).pipe(
          Effect.timeoutOrElse({
            duration: LIMIT,
            orElse: () =>
              Effect.logWarning("CLIProxyPacer did not answer the files report in time", {
                sessionID: event.sessionID,
              }).pipe(Effect.as(null)),
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("CLIProxyPacer was not told a chat's edited files", {
                  sessionID: event.sessionID,
                  cause,
                }).pipe(Effect.as(null)),
          ),
        )
        if (!notice) return
        const content = normalizeContent(event.result.content, event.result.output)
        const last = content.findLastIndex((item) => item.type === "text")
        event.result = {
          ...event.result,
          content:
            last === -1
              ? [...content, { type: "text", text: notice }]
              : content.map((item, index) =>
                  index === last && item.type === "text" ? { ...item, text: `${item.text}\n\n${notice}` } : item,
                ),
        }
      }),
    )
  }),
}
