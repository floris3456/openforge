export * as PacerEnv from "./env.js"

import { createHmac } from "node:crypto"
import { readdir, readFile, realpath } from "node:fs/promises"
import { statSync, type Stats } from "node:fs"
import path from "path"
import type { HttpMiddleware } from "@opencode/ai/route"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { isRecord } from "@opencode/util/record"
import { PacerEndpoint } from "./endpoint.js"
import { PacerHeaders } from "./headers.js"
import { PacerHttp } from "./http.js"
import { PacerModels } from "./models.js"

// What openforge hands CLIProxyPacer of a chat's .env files (workspace spec `docs/specs/env-redaction.md`): every value
// of 12 bytes or more of the .env files of the chat's repository, which CPP hides as an exact value (its layer 1) in
// every request of the key. Each model request names the set by its digest; CPP refuses one whose set it does not hold
// (428 `env_values_unknown`, nothing sent upstream), and openforge then hands it the set and sends the request once
// more. The sets live in this process only, one per place, and are never logged.
//
// A place is read whole at its first request, then kept current by a look before each request at what the read found:
// each .env file's size, modification time and inode, and the modification time of each folder that holds a .env file
// (examples too) and of each repository's root, which a file made or removed in it changes. A changed file is read
// again; a changed folder is listed again for .env files. A .env file made in another folder is found once a tool call
// names it ({@link Interface.named}). openforge watches no chat's folders (only `.git/HEAD`), and a recursive watch
// would hold one inotify watch per folder (97,661 of them on the QuettaForge workspace); a watcher's event may also
// come after the request that carries a tool's output, where the look before it cannot.

/**
 * Where a chat's .env files are read: the root of its repository's checkout, nested repositories included (`deep`), or
 * only its own folder, for a chat in no project.
 */
export interface Place {
  readonly root: string
  readonly deep: boolean
}

/** The path CPP takes a set at. */
const PATH = "/pacer/v1/redaction/env"
/** Shorter than this a value would match ordinary text, as CPP's layer 1 leaves it out (`Needles::MIN_LEN`). */
const MIN_BYTES = 12
/** A .env file larger than this is no configuration and is not read. */
const MAX_FILE = 1024 * 1024
/** Folders the walk never enters. */
const SKIPPED = new Set([".git", "node_modules"])
/** What a 428 of CPP's says when it holds no set under the request's digest. */
const UNKNOWN = "env_values_unknown"

/** Whether a file named `name` holds values CPP is handed: `.env` and `.env.<anything>`, not an example. */
export function valueFile(name: string) {
  return (
    (name === ".env" || (name.startsWith(".env.") && name.length > 5)) && !/\.(example|sample|template)$/.test(name)
  )
}

/** Whether `name` is a .env file's, its values handed over or not: a folder holding one is looked at. */
function envName(name: string) {
  return name === ".env" || name.startsWith(".env.")
}

/**
 * Each value of a .env file's text as a dotenv reader takes it, cut as CPP's layer 1 cuts a value it holds
 * ({@link cut}), in the file's order: `KEY=value` and `export KEY=value`, a quoted value unquoted (over several lines
 * whole; in double quotes with `\n` and `\r` read as line breaks), comments and blank lines skipped. A plain value ends
 * at a `#` after a space, as most readers take it, and also at its first `#`, as dotenv does: both are taken.
 */
export function values(text: string) {
  const source = text.replace(/\r\n?/g, "\n")
  const out: string[] = []
  for (let at = 0; at < source.length; ) {
    const end = lineEnd(source, at)
    const assigned = ASSIGNMENT.exec(source.slice(at, end))
    if (!assigned) {
      at = end + 1
      continue
    }
    const rest = source.slice(at + assigned[0].length, end)
    const quote = rest[0]
    const close =
      quote === '"' || quote === "'" || quote === "`" ? closing(source, at + assigned[0].length + 1, quote) : -1
    if (close !== -1) {
      const quoted = source.slice(at + assigned[0].length + 1, close)
      cut(quote === '"' ? quoted.replaceAll("\\n", "\n").replaceAll("\\r", "\r") : quoted, out)
      at = lineEnd(source, close) + 1
      continue
    }
    // A quote never closed is part of no value.
    const plain = quote === '"' || quote === "'" || quote === "`" ? rest.slice(1) : rest
    const spaced = plain.replace(/\s#.*$/, "").trim()
    const first = plain.split("#")[0]!.trim()
    if (first !== spaced) cut(first, out)
    cut(spaced, out)
    at = end + 1
  }
  return out
}

const ASSIGNMENT = /^\s*(?:export\s+)?[\w.-]+(?:\s*=\s*|:\s+)/

function lineEnd(source: string, from: number) {
  const end = source.indexOf("\n", from)
  return end === -1 ? source.length : end
}

/** The quote that closes one opened before `from`; an escaped quote does not. -1 when none does. */
function closing(source: string, from: number, quote: string) {
  for (let at = from; at < source.length; at++) {
    if (source[at] === "\\" && source[at + 1] === quote) at++
    else if (source[at] === quote) return at
  }
  return -1
}

/**
 * A value cut as CPP's layer 1 cuts one it holds (`push_secret`, `crates/cpa-server/src/redaction.rs`): over several
 * lines, each line but a PEM block's `-----` ones; with spaces or semicolons, each token between spaces, semicolons and
 * commas, a `name=value` token's value alone; else whole. Each piece then as {@link piece} takes it.
 */
function cut(value: string, out: string[]) {
  const trimmed = value.trim()
  if (trimmed.includes("\n")) {
    for (const line of trimmed.split("\n")) if (!line.trimStart().startsWith("-----")) cut(line, out)
    return
  }
  if (/\s/.test(trimmed) || trimmed.includes(";")) {
    for (const token of trimmed.split(/[\s;,]/)) piece(/^[A-Za-z0-9_.-]+=(.+)$/.exec(token)?.[1] ?? token, out)
    return
  }
  piece(trimmed, out)
}

/**
 * A piece of 12 bytes or more, whatever its name; not a path, a password hash or a URL, which layer 1 leaves out too
 * (`push_value`), but a URL's password, as layer 1 takes a connection string's.
 */
function piece(value: string, out: string[]) {
  const trimmed = value.trim()
  if (trimmed.includes("://")) {
    const password = /^[a-z][a-z0-9+.-]*:\/\/[^/:@\s]*:([^@/\s]+)@/i.exec(trimmed)?.[1]
    if (password) piece(password, out)
    return
  }
  if (
    Buffer.byteLength(trimmed) < MIN_BYTES ||
    trimmed.includes("\0") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("$2")
  )
    return
  out.push(trimmed)
}

/** The set: each value once, sorted by its UTF-8 bytes, as CPP sorts its strings. */
export function sorted(values: Iterable<string>) {
  return [...new Set(values)]
    .map((value) => ({ value, bytes: Buffer.from(value) }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map((entry) => entry.value)
}

/**
 * The set's digest: HMAC-SHA-256 over its values joined by one NUL byte, keyed with the client key's bytes, in
 * lower-case hex. Keyed, because request logs show headers and a plain hash of a set of one short value could be
 * guessed back from them.
 */
export function digest(key: string, set: ReadonlyArray<string>) {
  return createHmac("sha256", key).update(set.join("\0")).digest("hex")
}

export interface Interface {
  /** The set of `place` now: read at its first ask, then kept current by a look at what was found. */
  readonly current: (place: Place) => Effect.Effect<ReadonlyArray<string>>
  /**
   * Notes the folders of the .env files a tool call's `input` names, as a write tool's path or a command's words name
   * them (relative ones from `directory`, or the call's own `workdir`): a file made there is in the set from the next
   * look on.
   */
  readonly named: (place: Place, input: unknown, directory: string) => Effect.Effect<void>
  /**
   * HTTP middleware for a model request to CPP of a chat in `place`: names the set (`X-Pacer-Env`), and on CPP's
   * refusal of an unknown set hands it over and sends the same request once more. A second refusal, or a set CPP does
   * not take, fails the request with a plain error; it never goes without the set. Nothing while the catalog says the
   * server lacks `redaction.env`, while no CPP is set up, or while the place has no value. A catalog not read yet, as
   * after a restart, names it.
   */
  readonly http: (place: Place) => HttpMiddleware
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerEnv") {}

/** What a look compares: a file's or a folder's size, modification time and inode. */
interface Mark {
  readonly size: number
  readonly mtime: number
  readonly ino: number
}

interface State {
  readonly lock: Semaphore.Semaphore
  /** The place's root as its real path, which a linked .env file must lie within; undefined until the first read. */
  root?: string
  /** The .env files whose values are handed over, with what their read saw. */
  readonly files: Map<string, Mark & { readonly values: ReadonlyArray<string> }>
  /** The folders looked at; undefined for one a tool call named, which the next look lists. */
  readonly folders: Map<string, Mark | undefined>
  set: ReadonlyArray<string>
}

/** How many places' sets are kept: one or two per project a chat works in. */
const KEPT = 64

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* PacerModels.Service
    const endpoints = yield* PacerEndpoint.Service
    const http = yield* PacerHttp.Service
    const states = new Map<string, State>()
    const digests = new WeakMap<ReadonlyArray<string>, { readonly key: string; readonly digest: string }>()

    const stateOf = (place: Place) => {
      const found = states.get(keyOf(place))
      if (found) return found
      const made: State = { lock: Semaphore.makeUnsafe(1), files: new Map(), folders: new Map(), set: [] }
      if (states.size >= KEPT) states.clear()
      states.set(keyOf(place), made)
      return made
    }

    const current = (place: Place) =>
      Effect.suspend(() => {
        // The home folder holds every project's .env files, and others' (workspace spec, section 2).
        if (FSUtil.contains(place.root, Global.Path.home)) return Effect.succeed<ReadonlyArray<string>>([])
        const state = stateOf(place)
        return state.lock.withPermit(
          Effect.promise(() => (state.root === undefined ? read(place, state) : look(state, state.root))),
        )
      })

    const digestOf = (key: string, set: ReadonlyArray<string>) => {
      const found = digests.get(set)
      if (found?.key === key) return found.digest
      const made = digest(key, set)
      digests.set(set, { key, digest: made })
      return made
    }

    const handed = (
      endpoint: PacerEndpoint.Endpoint,
      sent: HttpClientRequest.HttpClientRequest,
      set: ReadonlyArray<string>,
      named: string,
    ) =>
      http
        .put(PATH, new TextEncoder().encode(JSON.stringify({ digest: named, values: set })), "application/json", {
          endpoint,
        })
        .pipe(
          Effect.map(() => undefined),
          Effect.catch((error) =>
            Effect.succeed(
              error._tag === "PacerHttp.Unreachable"
                ? plain(
                    sent,
                    503,
                    `CLIProxyPacer could not be reached to take the chat's .env values: ${error.reason}`,
                    error.retryAfter,
                  )
                : plain(
                    sent,
                    428,
                    `CLIProxyPacer did not take the chat's .env values, so the request was not sent without them: ${reasonOf(error)}`,
                  ),
            ),
          ),
        )

    return Service.of({
      current,
      named: (place, input, directory) =>
        Effect.sync(() => {
          const state = states.get(keyOf(place))
          if (!place.deep || !state) return
          const base =
            isRecord(input) && typeof input.workdir === "string" ? path.resolve(directory, input.workdir) : directory
          for (const text of strings(input))
            for (const match of text.matchAll(NAMED)) {
              const folder = path.resolve(base, match[1] || ".")
              if (FSUtil.contains(place.root, folder) && !state.folders.has(folder))
                state.folders.set(folder, undefined)
            }
        }),
      http: (place) => (request, handler) =>
        Effect.gen(function* () {
          const catalog = yield* models.get()
          const endpoint = yield* endpoints.get()
          if (!endpoint || (catalog !== undefined && catalog.pacer?.redaction?.env !== true))
            return yield* handler(request)
          const set = yield* current(place)
          if (set.length === 0) return yield* handler(request)
          const named = digestOf(endpoint.key, set)
          const sent = HttpClientRequest.setHeader(request, PacerHeaders.ENV, named)
          const first = yield* refusal(yield* handler(sent))
          if (first.passes) return first.response
          const failed = yield* handed(endpoint, sent, set, named)
          if (failed) return failed
          const again = yield* refusal(yield* handler(sent))
          if (again.passes) return again.response
          return plain(
            sent,
            428,
            "CLIProxyPacer refused this request again after openforge sent it the chat's .env values; it was not sent without them.",
          )
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [PacerModels.node, PacerEndpoint.node, PacerHttp.node],
})

const keyOf = (place: Place) => `${place.deep ? "repository" : "folder"}:${place.root}`

/** A path a tool call names that ends in a .env file's name; its first group the folder, as written. */
const NAMED = /((?:[^\s"'`<>|;&(){}=:,\\]*\/)?)\.env(?:\.[\w-]+)*(?![\w.-])/g

/** Every string in a tool call's input that mentions a .env file. */
function strings(input: unknown): ReadonlyArray<string> {
  if (typeof input === "string") return input.includes(".env") ? [input] : []
  if (Array.isArray(input)) return input.flatMap(strings)
  if (isRecord(input)) return Object.values(input).flatMap(strings)
  return []
}

/** Whether `response` passes as it came: anything but CPP's 428 for an unknown set, whose body is read to tell. */
const refusal = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status !== 428) return { passes: true as const, response }
    const text = yield* response.text.pipe(Effect.mapError((error) => new Error(error.message)))
    const error = errorOf(text)
    if (error?.code === UNKNOWN || error?.type === UNKNOWN) return { passes: false as const }
    return {
      passes: true as const,
      response: HttpClientResponse.fromWeb(
        response.request,
        new Response(text, { status: response.status, headers: response.headers }),
      ),
    }
  })

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ type: Schema.optional(Schema.String), code: Schema.optional(Schema.String) }),
    }),
  ),
)

const errorOf = (text: string) => Option.getOrUndefined(decodeError(text))?.error

/**
 * An answer of openforge's own in CPP's error shape, which the request fails with as with CPP's own: a 428, which no
 * retry sends again, or a 503 for a CPP that could not be reached, which the step's retry waits out.
 */
function plain(request: HttpClientRequest.HttpClientRequest, status: number, message: string, retryAfter?: number) {
  return HttpClientResponse.fromWeb(
    request,
    Response.json(
      { error: { type: "env_values_not_sent", message } },
      {
        status,
        ...(retryAfter === undefined ? {} : { headers: { "retry-after": String(Math.ceil(retryAfter / 1000)) } }),
      },
    ),
  )
}

function reasonOf(error: PacerHttp.Error) {
  return "reason" in error ? error.reason : error.message
}

/** A path's size, modification time and inode; undefined when it is gone or cannot be read. */
function markOf(file: string): Mark | undefined {
  const stats = statOrUndefined(file)
  return stats && { size: stats.size, mtime: stats.mtimeMs, ino: stats.ino }
}

function statOrUndefined(file: string): Stats | undefined {
  try {
    return statSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

const same = (a: Mark, b: Mark) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino

/** The first read of a place: its repository walked whole, or its own folder listed. */
async function read(place: Place, state: State) {
  const root = await realpath(place.root).catch(() => place.root)
  state.root = root
  const walk = async (folder: string, top: boolean): Promise<void> => {
    const mark = markOf(folder)
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const below: string[] = []
    const reads: Array<Promise<void>> = []
    const looked = top || entries.some((entry) => entry.name === ".git" || envName(entry.name))
    if (looked && mark) state.folders.set(folder, mark)
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) below.push(file)
      else if ((entry.isFile() || entry.isSymbolicLink()) && valueFile(entry.name)) reads.push(take(root, file, state))
    }
    await Promise.all([...reads, ...(place.deep ? below.map((next) => walk(next, false)) : [])])
  }
  await walk(place.root, true)
  state.set = sorted([...state.files.values()].flatMap((file) => file.values))
  return state.set
}

/** Reads one .env file into the place's files, when it lies within the place (a link out of it is not followed). */
async function take(root: string, file: string, state: State) {
  const real = await realpath(file).catch(() => undefined)
  const mark = markOf(file)
  if (!real || !mark || mark.size > MAX_FILE || !FSUtil.contains(root, real)) {
    state.files.delete(file)
    return
  }
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) state.files.delete(file)
  else state.files.set(file, { ...mark, values: values(text) })
}

/** The look before each request: each known file and folder against what was seen of it. */
async function look(state: State, root: string) {
  const reads: string[] = []
  let changed = false
  for (const [file, seen] of state.files) {
    const mark = markOf(file)
    if (!mark) {
      state.files.delete(file)
      changed = true
    } else if (!same(mark, seen)) reads.push(file)
  }
  const listed: Array<Promise<void>> = []
  for (const [folder, seen] of state.folders) {
    const mark = markOf(folder)
    if (!mark) state.folders.delete(folder)
    else if (!seen || !same(mark, seen)) {
      state.folders.set(folder, mark)
      listed.push(
        readdir(folder).then(
          (names) => {
            for (const name of names) {
              const file = path.join(folder, name)
              if (valueFile(name) && !state.files.has(file)) reads.push(file)
            }
          },
          () => undefined,
        ),
      )
    }
  }
  if (listed.length > 0) await Promise.all(listed)
  if (reads.length === 0 && !changed) return state.set
  await Promise.all(reads.map((file) => take(root, file, state)))
  state.set = sorted([...state.files.values()].flatMap((file) => file.values))
  return state.set
}
