export * as RunnerProtocol from "./protocol.js"

import { Schema } from "effect"

// JSON lines over the runner's Unix socket. The runner greets first with the protocol versions it speaks; the client
// answers with `hello` (the version it picked and the token) and then sends requests, each with its own `id`, which
// every frame answering it repeats. Version 1 is frozen once released: a later release adds a version and keeps
// speaking this one to runners of the release before it (see test/fixture/runner-v1.ts).

/** The versions a client of this release can speak, newest first. */
export const SUPPORTED = [1] as const
/** The versions this release's runner speaks. */
export const SPOKEN = [1] as const

/** The longest line either side accepts. */
export const MAX_LINE = 4 * 1024 * 1024

export const Layout = Schema.Struct({ head: Schema.Number, marker: Schema.Number, kept: Schema.Number })

/** Opaque to the runner: what its client needs to know the command again later. */
export const Meta = Schema.Record(Schema.String, Schema.Unknown)

/** How a command ended; also the content of its `<id>.exit` file. */
export const Exit = Schema.Struct({
  id: Schema.String,
  // `failed` is written by a client that found the runner gone while the command ran.
  status: Schema.Literals(["exited", "timeout", "killed", "failed"]),
  code: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  started: Schema.Number,
  ended: Schema.Number,
  /** Bytes the command printed, including dropped ones. */
  size: Schema.Number,
  /** Newlines the command printed, including dropped ones. */
  lines: Schema.Number,
  /** Present when bytes were dropped. */
  layout: Schema.optional(Layout),
  meta: Meta,
})
export type Exit = typeof Exit.Type

export const Command = Schema.Struct({
  id: Schema.String,
  pid: Schema.Number,
  /** The command's process group; the client stops it itself if the runner dies. */
  pgid: Schema.Number,
  started: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
  output: Schema.String,
  size: Schema.Number,
  meta: Meta,
  removed: Schema.optional(Schema.Boolean),
  exit: Schema.optional(Exit),
})
export type Command = typeof Command.Type

export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocols: Schema.Array(Schema.Number),
  version: Schema.String,
  pid: Schema.Number,
})
export type Hello = typeof Hello.Type

export const Start = Schema.Struct({
  id: Schema.String,
  /** Final: the client has already wrapped it (for example in a sandbox). */
  argv: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  /** Milliseconds since the epoch, held by the runner. */
  deadline: Schema.NullOr(Schema.Number),
  output: Schema.String,
  meta: Meta,
})
export type Start = typeof Start.Type

export const Request = Schema.Union([
  Schema.Struct({ id: Schema.Number, op: Schema.Literal("hello"), protocol: Schema.Number, token: Schema.String }),
  Schema.Struct({ id: Schema.Number, op: Schema.Literal("start"), command: Start }),
  Schema.Struct({
    id: Schema.Number,
    op: Schema.Literal("watch"),
    command: Schema.String,
    offset: Schema.Number,
    /** Without output, the watch only reports the exit. */
    output: Schema.Boolean,
    /** Skip ahead whenever the watcher is more than this many bytes behind; frames are then paced. */
    lag: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    id: Schema.Number,
    op: Schema.Literal("signal"),
    command: Schema.String,
    signal: Schema.String,
    /** Delete the command's files once it has ended. */
    remove: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    id: Schema.Number,
    op: Schema.Literal("deadline"),
    command: Schema.String,
    deadline: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ id: Schema.Number, op: Schema.Literal("list") }),
])
export type Request = typeof Request.Type

export const ErrorCode = Schema.Literals(["auth", "protocol", "closing", "unknown", "spawn", "invalid"])
export type ErrorCode = typeof ErrorCode.Type

export const Frame = Schema.Union([
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("ok") }),
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("started"), command: Command, existing: Schema.Boolean }),
  /** Answers `deadline`, and opens a watch with the command as it is now. */
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("command"), command: Command }),
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("list"), commands: Schema.Array(Command) }),
  Schema.Struct({
    id: Schema.Number,
    type: Schema.Literal("output"),
    /** Logical offset of the first byte; past the expected one when bytes were dropped or skipped. */
    offset: Schema.Number,
    /** Base64. */
    data: Schema.String,
    size: Schema.Number,
  }),
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("exit"), exit: Exit }),
  Schema.Struct({
    id: Schema.NullOr(Schema.Number),
    type: Schema.Literal("error"),
    code: ErrorCode,
    message: Schema.String,
  }),
  /** The runner is exiting because nothing runs any more. */
  Schema.Struct({ type: Schema.Literal("bye") }),
])
export type Frame = typeof Frame.Type

export const decodeHello = Schema.decodeUnknownOption(Schema.fromJsonString(Hello))
export const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request))
export const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))
export const decodeExit = Schema.decodeUnknownOption(Schema.fromJsonString(Exit))

/** Splits a byte stream into lines, refusing one longer than `MAX_LINE`. */
export function lines(onLine: (line: string) => void, onOverflow: () => void) {
  let pending = ""
  return (chunk: string) => {
    pending += chunk
    for (let index = pending.indexOf("\n"); index !== -1; index = pending.indexOf("\n")) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      if (line) onLine(line)
    }
    if (pending.length > MAX_LINE) {
      pending = ""
      onOverflow()
    }
  }
}
