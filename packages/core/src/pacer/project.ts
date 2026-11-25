export * as PacerProject from "./project.js"

import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { Node, makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Instance } from "../instance/service.js"
import { Location } from "../location.js"
import { MemoryClient } from "../memory/client.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { PacerHeaders } from "./headers.js"

// How a chat's project is named to CPP (workspace spec `docs/specs/cpp-projects.md`): only a chat whose folder is in a
// git repository has one (workspace task pwtnjy3faa8k: "a project is only created in cpp, including the tools the agent
// receives, when the root folder sits in git"). The identity is the chat's memory project (`MemoryClient.project`), the
// name and remote are this location's, worked out once with it (the remote by `Project.resolve`, which already reads
// it), so a request runs no git and builds its headers once per project.
//
// A helper whose own folder gives it none is in the project of the nearest chat up its tree that has one, named as that
// chat's location names it (workspace task 0v61fkfkn7sh): a lead moved into a repository keeps its helpers, which stay
// in the folder they were made in, on its board. Nothing is created for it.

/** How many projects' headers are kept; a location's chats name one or two. */
const KEPT = 16
/** How many helpers' answers are kept. */
const KEPT_HELPERS = 512
/** How far up a chat tree a helper's project is looked for, as CPP follows a chat's parents. */
const DEPTH = 16

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

/** What names a chat's place in its tree. */
export type Placed = Pick<SessionSchema.Info, "id" | "projectID" | "parentID">

export interface Interface {
  /** The memory project of a chat of this location in project `projectID`, and its headers. */
  readonly chat: (projectID: string) => Effect.Effect<Chat>
  /**
   * The project chat `session` of this location is in: its own ({@link chat}), else, for a helper whose own has none,
   * its nearest ancestor's that has one ({@link Ancestors}); a chat no ancestor gives one keeps its own answer.
   */
  readonly session: (session: Placed) => Effect.Effect<Chat>
  /** The headers naming `project`, a memory project of this location's chats. */
  readonly headers: (project: string) => Readonly<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerProject") {}

/** The location a chat asks from: where it is, and its own answer for a chat there ({@link Interface.chat}). */
export interface Here {
  readonly location: Pick<Location.Interface, "directory" | "workspaceID">
  readonly chat: Interface["chat"]
}

export interface AncestorsInterface {
  /**
   * The chat of `session`'s nearest ancestor whose own folder gives it a project, as that ancestor's own location
   * names it (`here`'s own answer for an ancestor in the same location); none when no ancestor has one. Worked out
   * once per chat, until a chat moves.
   */
  readonly nearest: (session: Placed, here: Here) => Effect.Effect<Chat | undefined>
}

export class Ancestors extends Context.Service<Ancestors, AncestorsInterface>()("@opencode/PacerProject/Ancestors") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const config = yield* Config.Service
    const ancestors = yield* Ancestors
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

    // Config's entries are one array until it reloads, so a chat's answer holds till then.
    const chat = (projectID: string) =>
      config.entries().pipe(
        Effect.map((entries): Chat => {
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
      )

    const here: Here = { location, chat }

    return Service.of({
      headers,
      chat,
      session: (session) =>
        chat(session.projectID).pipe(
          Effect.flatMap((own) =>
            own.project !== undefined || session.parentID === undefined
              ? Effect.succeed(own)
              : ancestors.nearest(session, here).pipe(Effect.map((found) => found ?? own)),
          ),
        ),
    })
  }),
)

const ancestorsLayer = Layer.effect(
  Ancestors,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const found = new Map<SessionSchema.ID, Chat | undefined>()
    // A move changes the folder, so the project, of a chat up a helper's tree: every answer is worked out again. One
    // worked out while a move was seen is not kept.
    const moves = { seen: 0 }
    yield* bus.subscribe([SessionEvent.Moved]).pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          moves.seen++
          found.clear()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const up = (parentID: SessionSchema.ID | undefined, here: Here, steps: number): Effect.Effect<Chat | undefined> =>
      Effect.gen(function* () {
        if (parentID === undefined || steps === 0) return undefined
        const parent = yield* store.get(parentID)
        if (parent === undefined) return undefined
        const chat =
          parent.location.directory === here.location.directory &&
          parent.location.workspaceID === here.location.workspaceID
            ? yield* here.chat(parent.projectID)
            : yield* instances
                .provide(parent)(Service.use((projects) => projects.chat(parent.projectID)))
                // An ancestor whose folder is gone gives none.
                .pipe(Effect.catchTag("FileSystem.DirectoryNotFoundError", () => Effect.succeed(undefined)))
        if (chat?.project !== undefined) return chat
        return yield* up(parent.parentID, here, steps - 1)
      })

    return Ancestors.of({
      nearest: (session, here) =>
        Effect.gen(function* () {
          if (found.has(session.id)) return found.get(session.id)
          const seen = moves.seen
          const chat = yield* up(session.parentID, here, DEPTH)
          if (moves.seen !== seen) return chat
          if (found.size >= KEPT_HELPERS) found.clear()
          found.set(session.id, chat)
          return chat
        }),
    })
  }),
)

// Typed, as Session.node is, to break a type cycle: its layer reads an ancestor's location's services, which hold
// PacerProject, whose node depends on this one.
export const ancestorsNode: LayerNode.Provider<Ancestors, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Ancestors,
  layer: ancestorsLayer,
  deps: [SessionStore.node, Instance.node, Bus.node],
})

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node, Config.node, ancestorsNode] })

/** The location's name for CPP: the folder name of the repository's main checkout, and its normalised remote. */
export function placeOf(location: Pick<Location.Interface, "project" | "remote">): PacerHeaders.Place {
  return {
    name: path.basename(location.project.canonical),
    ...(location.remote ? { remote: location.remote } : {}),
  }
}
