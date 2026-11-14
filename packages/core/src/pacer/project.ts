export * as PacerProject from "./project.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { MemoryClient } from "../memory/client.js"
import { PacerHeaders } from "./headers.js"

// How a chat's project is named to CPP (workspace spec `docs/specs/cpp-projects.md`): the identity is the chat's memory
// project (`MemoryClient.project`), the name and remote are this location's, worked out once with it (the remote by
// `Project.resolve`, which already reads it), so a request runs no git and builds its headers once per project.

/** How many projects' headers are kept; a location's chats name one or two. */
const KEPT = 16

export interface Chat {
  /** The chat's memory project; undefined for a chat outside any project, which has no memory. */
  readonly project: string | undefined
  /** The headers naming it ({@link PacerHeaders.project}); none without a project. */
  readonly headers: Readonly<Record<string, string>>
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
            const project = MemoryClient.project(entries, projectID)
            const chat = { project, headers: project === undefined ? {} : headers(project) }
            if (chats.size >= KEPT) chats.clear()
            chats.set(projectID, { entries, chat })
            return chat
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node, Config.node] })

/**
 * The location's name for CPP: the normalised remote when the repository has one, else the repository's folder name
 * (its main checkout's), else the folder's.
 */
export function placeOf(location: Pick<Location.Interface, "project" | "remote">): PacerHeaders.Place {
  return {
    name: location.remote ?? path.basename(location.project.canonical),
    ...(location.remote ? { remote: location.remote } : {}),
  }
}
