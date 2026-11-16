export * as TaskFilesPlugin from "./task-files.js"

import path from "path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { FSUtil } from "@opencode/util/fs-util"
import { isRecord } from "@opencode/util/record"
import { Cause, Clock, Effect } from "effect"
import { Git } from "../git.js"
import { MemoryClient } from "../memory/client.js"
import { MemoryTask } from "../memory/task.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerHeaders } from "../pacer/headers.js"
import { PacerModels } from "../pacer/models.js"
import { PacerProject } from "../pacer/project.js"
import { AbsolutePath } from "../schema.js"
import { normalizeContent } from "../tool/runtime.js"
import { EditTool } from "../tool/plugin/edit.js"
import { PatchTool } from "../tool/plugin/patch.js"
import { WriteTool } from "../tool/plugin/write.js"

// The files report (workspace reference `docs/reference/task-system-later-api.md`, "Edited files and the clash notice"):
// after each successful edit, write or patch in a chat whose latest step went through CLIProxyPacer, on a server with
// memory `later`, while the chat is inside a task (its metadata's place), openforge tells CPP the paths the call changed,
// each named as one file is wherever it is edited from: `<repository>/<path inside it>` in a git repository, the
// repository named by the folder that holds its common git directory (so every worktree of it names a file alike), and
// its absolute path outside git. CPP keeps them for the chat's task and may answer a clash notice, which goes at the end of the
// tool's result, so the chat's history keeps it. The edit waits for the answer at most `LIMIT`; a timeout or failure
// adds nothing and is only logged.

/** How long an edit waits for the report's answer. */
export const LIMIT = "500 millis"
/** Chats held whose latest step went through CPP; past it the oldest goes. */
export const CHATS = 1_000
/** At most this many paths a report, each at most `PATH` characters. */
export const PATHS = 50
export const PATH = 500
/** Folders whose repository is held, so that an edit costs no git call after the first in its folder. */
export const FOLDERS = 1_000

const provider: string = PacerEndpoint.id

/**
 * The absolute paths a successful call of one of openforge's edit tools changed, as its output names them: an edit's
 * file relative to the chat's folder `directory` (or absolute outside it), a write's and a patch's targets.
 */
export function paths(tool: string, output: unknown, directory: string): string[] {
  if (!isRecord(output)) return []
  const items = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : [])
  const found =
    tool === EditTool.name
      ? items(output.files).map((file) => file.file)
      : tool === WriteTool.name
        ? [output.target]
        : tool === PatchTool.name
          ? items(output.applied).map((item) => item.target)
          : []
  return [
    ...new Set(
      found
        .filter((item): item is string => typeof item === "string" && item !== "")
        .map((item) => path.resolve(directory, item)),
    ),
  ]
}

/** What a folder's file is named by: its repository's name and top folder, or nothing outside git. */
export type Repository = { readonly name: string; readonly worktree: string } | undefined

/** The repository's name: the folder that holds its common git directory (`repos/openforge/.git` → `openforge`). */
export function repositoryName(commonDirectory: string) {
  return path.basename(path.dirname(commonDirectory))
}

/** The file's name in the report: `<repository>/<path inside it>`, or its absolute path outside git. */
export function named(file: string, repository: Repository) {
  if (!repository) return file.split(path.sep).join("/")
  const inside = path.relative(repository.worktree, file)
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return file.split(path.sep).join("/")
  return `${repository.name}/${inside.split(path.sep).join("/")}`
}

export const Plugin = {
  id: "opencode.task-files",
  effect: Effect.fn("TaskFilesPlugin")(function* (ctx: Context) {
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service
    const projects = yield* PacerProject.Service
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    // Each folder's repository (its real path, as git names its top folder), as the first edit in it found it.
    const folders = new Map<string, { readonly real: string; readonly repository: Repository }>()
    const folder = Effect.fnUntraced(function* (directory: string) {
      const held = folders.get(directory)
      if (held) return held
      const real = yield* fs.resolve(directory)
      const found = yield* git.repo.discover(AbsolutePath.make(real))
      const value = {
        real,
        repository: found && { name: repositoryName(found.commonDirectory), worktree: found.worktree },
      }
      folders.set(directory, value)
      if (folders.size > FOLDERS) folders.delete(folders.keys().next().value!)
      return value
    })
    /** The report's names of the call's files: each once, at most `PATHS`, none longer than `PATH`. */
    const name = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
      const names = yield* Effect.forEach(files, (file) =>
        folder(path.dirname(file)).pipe(
          Effect.map((found) => named(path.join(found.real, path.basename(file)), found.repository)),
        ),
      )
      return [...new Set(names.filter((item) => item.length <= PATH))].slice(0, PATHS)
    })
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
    const report = Effect.fnUntraced(function* (sessionID: Session.ID, agent: string, files: ReadonlyArray<string>) {
      if ((yield* catalogs.get())?.pacer?.memory?.later !== true) return null
      const session = yield* ctx.session.get({ sessionID })
      if (!MemoryTask.inside(session.metadata)) return null
      const memory = yield* projects.chat(session.projectID)
      if (memory.project === undefined) return null
      const changed = yield* name(files)
      if (changed.length === 0) return null
      const at = yield* Clock.currentTimeMillis
      return yield* client
        .withHeaders(PacerHeaders.chat({ sessionID, parentID: session.parentID, project: memory.headers, agent }))
        .files(memory.project, { paths: changed, at }, { timeout: LIMIT })
    })

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed" || !through.has(event.sessionID)) return
        const files = paths(event.tool, event.result.output, ctx.location.directory)
        if (files.length === 0) return
        const notice = yield* report(event.sessionID, String(event.agent), files).pipe(
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
