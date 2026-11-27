export * as PacerToolsPlugin from "./pacer-tools.js"

import { isUtf8 } from "node:buffer"
import path from "path"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { PictureRemoved } from "@opencode/util/picture-removed"
import { isRecord } from "@opencode/util/record"
import { Effect, Stream } from "effect"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { ImageBank } from "../../image/bank.js"
import { MemoryHandIn } from "../../memory/hand-in.js"
import { MemoryTask } from "../../memory/task.js"
import { Mime } from "../../mime.js"
import { PacerHttp } from "../../pacer/http.js"
import { PacerProject } from "../../pacer/project.js"
import { PacerTools } from "../../pacer/tools.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionBlob } from "../../session/blob.js"

// Every tool CPP lists, as built-in tools: one per name its lists and capabilities named at the current endpoint
// (`PacerTools.known`, kept across restarts, so a step resumed right after one sends the tools it had), each asking
// the permission its meta names, where its meta places it (`codemode`). Nothing here knows any of them: CPP holds
// their definitions, rules and texts (the workspace's specs `docs/specs/cpp-tools.md`, `web-tools-code-mode.md`).
// A direct tool's definition here never reaches a model: each request puts the chat's own from CPP in its place, or
// leaves it out (`PacerOffer`). A Code Mode tool is described by CPP's definition, one for every chat, as Code Mode's
// registry is; a chat whose list doesn't hold it has none in its catalog (`SessionContext`), and a call of it is
// answered that it is unavailable.

/** CPP's definitions, from the chat's list, replace these on every request (a Code Mode tool's: when it has none). */
const placeholder = "One of CLIProxyPacer's tools; each request carries CLIProxyPacer's own definition instead."

export const Plugin = {
  id: "opencode.tool.pacer-tools",
  effect: Effect.fn("PacerToolsPlugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const calls = yield* PacerTools.Service
    const sessions = yield* Session.Service
    const projects = yield* PacerProject.Service
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service
    const handIn = yield* MemoryHandIn.Service

    /** What the model wrote, when the call does not go: `Not sent:` and why, and nothing reaches CPP. */
    const notSent = (reason: string, metadata?: Readonly<Record<string, unknown>>) =>
      new ToolFailure({ message: `Not sent: ${reason}`, ...(metadata ? { metadata } : {}) })

    /** Image `number` of the chat, as `image.show` numbers them: its original's hash, and its name `image N`. */
    const fromChat = Effect.fnUntraced(function* (written: string, number: number) {
      const chat = yield* ImageBank.Current
      if (!chat) return yield* notSent(`${written} is not an image of this chat`)
      const found = yield* ImageBank.get(chat.db, chat.sessionID, number)
      if (!found) return yield* notSent(`${written} is not an image of this chat`)
      if (!found.original) return yield* notSent(PictureRemoved.shown(written))
      yield* calls
        .upload(found.original.data, found.original.mime, found.image.hash)
        .pipe(Effect.mapError((error) => notSent(`${written} could not be uploaded (${uploadReason(error)})`)))
      return { sha256: found.image.hash, name: `image ${number}` }
    })

    /**
     * One file the model wrote (`#N`, or a path the chat may read): a picture, or a text by its name (`.md`, `.txt`,
     * read as UTF-8), read, hashed, sent to CPP once, and named.
     */
    const file = Effect.fnUntraced(function* (written: string, context: FileAccess.Invocation) {
      const number = /^#(\d+)$/.exec(written)?.[1]
      if (number !== undefined) return yield* fromChat(written, Number(number))
      const target = yield* access
        .authorizeRead(written, context)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
      // A file that cannot be described or read is answered as one that is not there: the model wrote a wrong path.
      const unreadable = () => notSent(`${written} does not exist`)
      const info = yield* environment.files.stat(target.absolute).pipe(Effect.catch(unreadable))
      const text = TEXT_TYPES[path.extname(written).toLowerCase()]
      if (text !== undefined && info.size > MAX_TEXT_BYTES)
        return yield* notSent(`${written} is ${Math.ceil(info.size / 1024)} KB, over 256 KB`)
      if (info.size > MAX_PICTURE_BYTES)
        return yield* notSent(`${written} is ${Math.ceil(info.size / MEGABYTE)} MB, over 20 MB`)
      const bytes = (yield* environment.files.read(target.absolute).pipe(Effect.catch(unreadable))).bytes
      if (text !== undefined && !isUtf8(bytes)) return yield* notSent(`${written} is not UTF-8 text`)
      const mime = text ?? pictureMime(bytes, written)
      if (mime === undefined) return yield* notSent(`${written} is not a picture or a text (.md, .txt)`)
      const sha256 = SessionBlob.hashBytes(bytes)
      yield* calls
        .upload(bytes, mime, sha256)
        .pipe(Effect.mapError((error) => notSent(`${written} could not be uploaded (${uploadReason(error)})`)))
      return { sha256, name: path.basename(written) }
    })

    /**
     * A call's arguments that hold local files (CPP's `meta.files`): each string of those is a file, replaced by its
     * hash and name once CPP holds its bytes, so the model writes only the paths; so are the first two of an array
     * (`[picture, comparison, comment]`) and an entry's named parts `picture`, `compare` and `text`. Anything else
     * (a decision, a comment) keeps its shape. Each holds at most as many items as the tool's schema allows it.
     */
    const withFiles = Effect.fn("PacerToolsPlugin.withFiles")(function* (
      input: Readonly<Record<string, unknown>>,
      named: ReadonlyArray<string> | undefined,
      schema: unknown,
      context: FileAccess.Invocation,
    ) {
      const fields = (named ?? []).filter((name) => input[name] !== undefined)
      if (fields.length === 0) return input
      const sent = { ...input }
      for (const name of fields) {
        const value = input[name]
        if (!Array.isArray(value)) continue
        const limit = itemLimit(schema, name)
        if (value.length > limit) return yield* notSent(`${name} has more than ${limit} items`)
        sent[name] = yield* Effect.forEach(value, (item) => {
          if (typeof item === "string") return file(item, context)
          // `[picture, comparison, caption]`: the first two are files, and the caption is text.
          if (Array.isArray(item))
            return Effect.forEach(item, (part, index) =>
              index < 2 && typeof part === "string" ? file(part, context) : Effect.succeed(part),
            )
          if (!isRecord(item)) return Effect.succeed(item)
          return Effect.gen(function* () {
            const named = { ...item }
            for (const part of FILE_PARTS) {
              const written = item[part]
              if (typeof written === "string") named[part] = yield* file(written, context)
            }
            return named
          })
        })
      }
      return sent
    })

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
            options:
              meta.codemode === true
                ? {
                    codemode: true,
                    permission: meta.permission,
                    pinned: meta.pinned === true,
                    reported: meta.reported === true,
                  }
                : { codemode: false, permission: meta.permission },
            description: (meta.codemode === true ? meta.definition?.description : undefined) ?? placeholder,
            input: (meta.codemode === true ? meta.definition?.input_schema : undefined) ?? { type: "object" },
            execute: (input, context) =>
              Effect.gen(function* () {
                // Code Mode's tools are the registry's, not the chat's: the chat's list still decides what it has.
                if (meta.codemode === true && calls.holds(context.sessionID, name) === false)
                  return yield* new ToolFailure({ message: `${name} is not available in this chat.` })
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
                // What the model wrote stays the call's own input; only what CPP is sent has the files' hashes, and a
                // hand-in that goes without its pictures the note that tells its lead. The schema is the chat's own copy
                // of the tool, or Code Mode's for every chat while the chat holds none.
                const schema =
                  calls.held(context.sessionID)?.byName.get(name)?.inputSchema ?? meta.definition?.input_schema
                const session = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                // A helper's work that made pictures goes to review with them, unless its pictures show none of its
                // work (the workspace's spec picture-hand-ins).
                const checked =
                  name === "task" && session
                    ? yield* handIn.check(session, String(context.agent), input, context.id)
                    : undefined
                if (checked !== undefined && "refused" in checked)
                  return yield* notSent(checked.refused, checked.metadata)
                const written = checked === undefined ? input : { ...args, note: checked.note }
                const sent = isRecord(written) ? yield* withFiles(written, meta.files, schema, context) : written
                // A subagent's calls are rows of its own chat, nested under its parent's, as its model requests are.
                const project = session ? (yield* projects.session(session)).headers : undefined
                const answer = yield* calls
                  .call({
                    sessionID: context.sessionID,
                    parentID: session?.parentID,
                    project,
                    agent: String(context.agent),
                    name,
                    args: sent,
                  })
                  // Not as the failure's cause, which would make it an unknown error rather than the tool's.
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                // CPP keeps the chat's place; openforge's own hooks read it from the session's metadata. Making a goal
                // from nothing never moves the chat; turning a task into one may.
                if (session && answer.place !== undefined && !MemoryTask.goalCall(name, args)) {
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
                // The row of a task turned into a goal names it ("Goal from task: <title>"), from CPP's answer.
                const title =
                  MemoryTask.promotion(name, args) && typeof answer.metadata.title !== "string"
                    ? MemoryTask.promotedTitle(answer.data, args.id)
                    : undefined
                return { content: answer.text, metadata: title ? { ...answer.metadata, title } : answer.metadata }
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

/**
 * The most items a file-bearing argument may hold: its `maxItems` in the tool's schema, on the argument or on a branch
 * of its `anyOf` or `oneOf` (`[{type: "array", maxItems: 100}, {type: "null"}]`), the largest one given; PICTURE_LIMIT
 * when the schema gives none, as an older CPP's.
 */
function itemLimit(schema: unknown, name: string) {
  const argument = isRecord(schema) && isRecord(schema.properties) ? schema.properties[name] : undefined
  if (!isRecord(argument)) return PICTURE_LIMIT
  const branches = [argument.anyOf, argument.oneOf].flatMap((list) => (Array.isArray(list) ? list : []))
  const limits = [argument, ...branches].flatMap((branch) =>
    isRecord(branch) &&
    typeof branch.maxItems === "number" &&
    Number.isSafeInteger(branch.maxItems) &&
    branch.maxItems > 0
      ? [branch.maxItems]
      : [],
  )
  return limits.length > 0 ? Math.max(...limits) : PICTURE_LIMIT
}

/** The most items a file-bearing argument may hold when the tool's schema says none, and the most one picture may weigh. */
const PICTURE_LIMIT = 20
const MAX_PICTURE_BYTES = 20 * 1024 * 1024
const MEGABYTE = 1024 * 1024
/** A text file's types by its name, and the most it may weigh. */
const TEXT_TYPES: Readonly<Record<string, string>> = { ".md": "text/markdown", ".txt": "text/plain" }
const MAX_TEXT_BYTES = 256 * 1024
/** An entry's parts that name a file, in an entry written as an object (`{picture, compare, comment}`, `{text}`). */
const FILE_PARTS = ["picture", "compare", "text"]
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
const SVG = "image/svg+xml"
/** `<svg` at the start, after an optional byte-order mark, XML declaration, comments and whitespace. */
const SVG_START = /^(?:\uFEFF|\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg[\s>]/i

/** A picture's type by its bytes: PNG, JPEG, WebP or GIF, or SVG by its markup (or a `.svg` name holding text). */
function pictureMime(bytes: Uint8Array, written: string) {
  const mime = Mime.detect(bytes)
  if (PICTURE_TYPES.includes(mime)) return mime
  // `near the start`: an SVG's markup comes first, however many declarations and comments precede it.
  const start = new TextDecoder().decode(bytes.subarray(0, 4096))
  if (SVG_START.test(start) || (written.toLowerCase().endsWith(".svg") && mime === "text/plain")) return SVG
  return undefined
}

/** Why CPP did not take a file, as the model is told: its answer's status, or what went wrong without one. */
function uploadReason(error: PacerHttp.Error) {
  return "status" in error && typeof error.status === "number" ? String(error.status) : error.message
}
