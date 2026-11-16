export * as PacerWhere from "./where.js"

import path from "path"
import { Clock, Context, Deferred, Duration, Effect, FiberSet, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Git } from "../git.js"
import { AbsolutePath } from "../schema.js"
import { SessionStore } from "../session/store.js"
import { PacerSessionID } from "./session-id.js"

// Where a chat works (workspace reference `docs/reference/task-system-later-api.md`, "From the benchmark after the later
// items", "Where"): every request to CLIProxyPacer for a chat carries `X-Pacer-Where: <folder>@<branch>`, the chat
// folder's git top folder with the home folder written `~` and its branch (a detached HEAD as its short commit); outside
// git the folder alone. Each folder is asked of git once and kept 30 s; after that its old value goes on being sent while
// git is asked again, so only a folder's first request waits for git, and never longer than `FIRST`.

/** How long a folder's value is kept before git is asked again. */
export const KEEP = Duration.seconds(30)
/** How long a folder's first request waits for git before it goes with the folder alone. */
export const FIRST = Duration.seconds(1)
/** The longest value sent; a longer one loses its start. */
export const LENGTH = 300
/** Folders kept; past it the oldest goes. */
export const FOLDERS = 1_000
/** The letters of a detached HEAD's commit that are sent. */
export const SHORT = 7

/** The header's value: `folder` (or its git `top`) with `home` written `~`, `@branch` in git, its last `LENGTH` letters. */
export function format(input: {
  readonly folder: string
  readonly top?: string
  readonly branch?: string
  readonly home: string
}) {
  const place = homed((input.top ?? input.folder).split(path.sep).join("/"), input.home.split(path.sep).join("/"))
  const letters = [...(input.top === undefined || !input.branch ? place : `${place}@${input.branch}`)]
  // A header holds no letter outside printable ASCII: those few go percent-encoded.
  return letters
    .slice(-LENGTH)
    .map((letter) => (/^[\x20-\x7e]$/.test(letter) ? letter : encodeURIComponent(letter.toWellFormed())))
    .join("")
}

function homed(place: string, home: string) {
  const root = home.replace(/\/+$/, "")
  if (root === "") return place
  if (place === root) return "~"
  return place.startsWith(`${root}/`) ? `~${place.slice(root.length)}` : place
}

export interface Interface {
  /** The value for a chat folder. */
  readonly folder: (directory: string) => Effect.Effect<string>
  /** The value for the chat CPP knows by `uuid` (its `X-Pacer-Session`), from its folder; none for a chat not found. */
  readonly chat: (uuid: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerWhere") {}

interface Held {
  value?: string
  at: number
  filling?: Deferred.Deferred<string>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const store = yield* SessionStore.Service
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const held = new Map<string, Held>()

    const ask = Effect.fnUntraced(function* (directory: string) {
      const repository = yield* git.repo.discover(AbsolutePath.make(directory))
      if (!repository) return format({ folder: directory, home: Global.Path.home })
      const branch = (yield* git.history.branch(repository)) ?? (yield* git.history.head(repository))?.slice(0, SHORT)
      return format({ folder: directory, top: repository.worktree, branch, home: Global.Path.home })
    })

    /** Asks git on a fiber of its own; a git error gives the folder alone. */
    const fill = (directory: string, entry: Held) => {
      const filling = Deferred.makeUnsafe<string>()
      entry.filling = filling
      fork(
        ask(directory).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("git did not say where a chat works", { directory, cause }).pipe(
              Effect.as(format({ folder: directory, home: Global.Path.home })),
            ),
          ),
          Effect.flatMap((value) =>
            Effect.gen(function* () {
              entry.value = value
              entry.at = yield* Clock.currentTimeMillis
              entry.filling = undefined
              yield* Deferred.succeed(filling, value)
            }),
          ),
        ),
      )
      return filling
    }

    const folder = Effect.fn("PacerWhere.folder")(function* (directory: string) {
      const now = yield* Clock.currentTimeMillis
      const found = held.get(directory)
      const entry = found ?? { at: now }
      held.delete(directory)
      held.set(directory, entry)
      if (!found && held.size > FOLDERS) held.delete(held.keys().next().value!)
      if (entry.value !== undefined) {
        if (now - entry.at >= Duration.toMillis(KEEP) && !entry.filling) fill(directory, entry)
        return entry.value
      }
      return yield* Deferred.await(entry.filling ?? fill(directory, entry)).pipe(
        Effect.timeoutOrElse({
          duration: FIRST,
          orElse: () => Effect.succeed(format({ folder: directory, home: Global.Path.home })),
        }),
      )
    })

    const chat = Effect.fn("PacerWhere.chat")(function* (uuid: string) {
      const sessionID = PacerSessionID.session(uuid)
      if (!sessionID) return undefined
      const session = yield* store.get(sessionID)
      if (!session) return undefined
      return yield* folder(session.location.directory)
    })

    return Service.of({ folder, chat })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Git.node, SessionStore.node] })
