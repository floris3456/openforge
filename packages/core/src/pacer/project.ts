export * as PacerProject from "./project.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { MemoryClient } from "../memory/client.js"
import { PacerHeaders } from "./headers.js"

// How a chat's project is named to CPP (workspace spec `docs/specs/cpp-projects.md`): only a chat whose folder is in a
// git repository has one (workspace task pwtnjy3faa8k: "a project is only created in cpp, including the tools the agent
// receives, when the root folder sits in git"). The identity is the chat's memory project (`MemoryClient.project`), the
// name and remote are this location's, worked out once with it (the remote by `Project.resolve`, which already reads
// it), so a request runs no git and builds its headers once per project.

/** How many projects' headers are kept; a location's chats name one or two. */
const KEPT = 16

/** Why a chat has no project, in plain words, for what tells the model so (workspace task c66m6k0sa6h6). */
export const OUTSIDE_GIT =
  "This chat's folder is not in a git repository, so it has no project, memory or task board. A chat started inside a git repository has one."
export const NO_IDENTITY =
  "This chat's git repository has no commit and no remote yet, so it has no project, memory or task board. It gets one with its first commit, or the setting memory.project can name one."

export type Chat =
  | {
      /** The chat's memory project. */
      readonly project: string
      /** The headers naming it ({@link PacerHeaders.project}). */
      readonly headers: Readonly<Record<string, string>>
    }
  | {
      /** A chat outside any project (outside git), which has no memory, and names none. */
      readonly project: undefined
      readonly headers: Readonly<Record<string, string>>
      /** Why: {@link OUTSIDE_GIT} or {@link NO_IDENTITY}. */
      readonly why: string
    }

export interface Interface {
  /** The memory project of a chat of this location in project `projectID`, and its headers. */
  readonly chat: (projectID: string) => Effect.Effect<Chat>
  /** The headers naming `project`, a memory project of this location's chats. */
  readonly headers: (project: string) => Readonly<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerProject") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const config = yield* Config.Service
    const place = placeOf(location)
    const git = location.vcs?.type === "git"
    const named = new Map<string, Readonly<Record<string, string>>>()
    const chats = new Map<string, { readonly entries: unknown; readonly chat: Chat }>()

    const headers = (project: string) => {
      const found = named.get(project)
      if (found) return found
      const made = PacerHeaders.project(project, place)
      if (named.size >= KEPT) named.clear()
      named.set(project, made)
      return made
    }

    return Service.of({
      headers,
      // Config's entries are one array until it reloads, so a chat's answer holds till then.
      chat: (projectID) =>
        config.entries().pipe(
          Effect.map((entries) => {
            const found = chats.get(projectID)
            if (found?.entries === entries) return found.chat
            const project = git ? MemoryClient.project(entries, projectID) : undefined
            const chat =
              project === undefined
                ? { project, headers: {}, why: git ? NO_IDENTITY : OUTSIDE_GIT }
                : { project, headers: headers(project) }
            if (chats.size >= KEPT) chats.clear()
            chats.set(projectID, { entries, chat })
            return chat
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node, Config.node] })

/** The location's name for CPP: the folder name of the repository's main checkout, and its normalised remote. */
export function placeOf(location: Pick<Location.Interface, "project" | "remote">): PacerHeaders.Place {
  return {
    name: path.basename(location.project.canonical),
    ...(location.remote ? { remote: location.remote } : {}),
  }
}
