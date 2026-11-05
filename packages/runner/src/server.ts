export * as RunnerServer from "./server.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { RunnerLock } from "./lock.js"
import { RunnerOutput } from "./output.js"
import { RunnerPaths } from "./paths.js"
import { RunnerProtocol } from "./protocol.js"

export type Options = {
  readonly directory: string
  /** The release this runner belongs to, reported in its greeting. */
  readonly version: string
  /** How long a runner with nothing to run, fresh or after its last command, waits for a command before it exits. */
  readonly grace?: number
  /** How long a group gets between SIGTERM and SIGKILL. */
  readonly killAfter?: number
  /** How long to wait for the folder's lock, which an exiting runner still holds for a moment. */
  readonly wait?: number
  readonly bounds?: RunnerOutput.Bounds
  /** Where the runner reports what went wrong: its stderr, which is the folder's log, by default. */
  readonly log?: (line: string) => void
}

export type Runner = {
  readonly pid: number
  readonly directory: string
  /** Settles once the runner has exited. */
  readonly closed: Promise<void>
  /** Stops every command (SIGTERM, then SIGKILL) and exits once they have ended. */
  readonly shutdown: () => Promise<void>
}

export class LockedError extends Error {
  constructor(readonly directory: string) {
    super(`another runner holds ${directory}`)
  }
}

const HIGH_WATER = 256 * 1024
const PACE = 50
const GRACE = 10_000
const LOCK_WAIT = 5_000
const LOCK_RETRY = 50
// How long clients still connected when the runner exits get to read their last frames.
const GOODBYE = 2_000
// A leader that exited may leave children holding its pipes; their output is read this much longer.
const DRAIN = 1_000
// Ended commands stay listed while the runner lives; their exit files outlast it.
const ENDED_LIMIT = 256
// An ended command leaves its process, its pipes and its requests behind as garbage, which the collector leaves
// lying until heap pressure. One collection (about 1 ms) after every this many keeps a stream of short commands from
// growing the runner (5000 commands: 62 instead of 73 MB on Linux, 74 instead of 83 MB on macOS).
const COLLECT_ENDED = 64

type Entry = {
  readonly id: string
  readonly output: string
  readonly meta: RunnerProtocol.Start["meta"]
  readonly pid: number
  readonly started: number
  readonly writer: RunnerOutput.Writer
  readonly watches: Set<Watch>
  deadline: number | null
  reason?: "timeout" | "killed"
  removed: boolean
  /** Its pipes have closed; `exit` follows once the exit file is written. */
  ended: boolean
  /** Writing its output failed once, which was reported; later failures are not. */
  lost: boolean
  exit?: RunnerProtocol.Exit
  deadlineTimer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
}

type Connection = {
  readonly socket: net.Socket
  readonly watches: Map<number, Watch>
  authenticated: boolean
}

type Watch = {
  readonly id: number
  readonly connection: Connection
  readonly entry: Entry
  readonly output: boolean
  readonly lag: number | undefined
  offset: number
  paced?: ReturnType<typeof setTimeout>
  waiting: boolean
}

/**
 * Runs the tool runner in this process: it owns the folder's lock, listens on its socket and runs the commands its
 * clients start, each in its own process group. It exits once nothing has run for its grace period.
 */
export async function serve(options: Options): Promise<Runner> {
  const directory = options.directory
  const killAfter = options.killAfter ?? RunnerProtocol.KILL_AFTER
  const report = options.log ?? ((line: string) => void process.stderr.write(`${new Date().toISOString()} ${line}\n`))
  // Something that failed for one command, reported instead of taking the runner and every other command down.
  const guarded = (what: string, action: () => void) => {
    try {
      action()
    } catch (cause) {
      report(`${what}: ${RunnerProtocol.messageOf(cause)}`)
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const acquired = await acquire(RunnerPaths.lock(directory), options.wait ?? LOCK_WAIT)
  if (!acquired) throw new LockedError(directory)
  const lock = acquired
  const token = randomBytes(32).toString("hex")
  const socketPath = RunnerPaths.socket(directory)
  await RunnerOutput.writeAtomic(RunnerPaths.token(directory), token)
  fs.rmSync(socketPath, { force: true })

  const entries = new Map<string, Entry>()
  const connections = new Set<Connection>()
  let endings = 0
  let closing = false
  let resolveClosed = () => {}
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
  const server = net.createServer((socket) => accept(socket))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  fs.chmodSync(socketPath, 0o600)
  let stopping = false
  let grace: ReturnType<typeof setTimeout> | undefined
  // Nothing runs: wait a while for the next command, so a burst of short ones shares this runner. Asked to stop, exit.
  function rest() {
    if ([...entries.values()].some((entry) => !entry.exit)) return
    if (stopping) return idle()
    clearTimeout(grace)
    grace = setTimeout(idle, options.grace ?? GRACE)
    grace.unref()
  }
  rest()

  function accept(socket: net.Socket) {
    if (closing) return socket.destroy()
    const connection: Connection = { socket, watches: new Map(), authenticated: false }
    connections.add(connection)
    socket.setEncoding("utf8")
    const read = RunnerProtocol.lines(
      (line) => receive(connection, line),
      () => fail(connection, null, "invalid", "line too long", true),
    )
    socket.on("data", read)
    socket.on("drain", () => connection.watches.forEach((watch) => watch.waiting && pump(watch)))
    // A client that goes away mid-write; the close that follows cleans up after it.
    socket.on("error", () => {})
    socket.on("close", () => {
      connections.delete(connection)
      connection.watches.forEach((watch) => clearTimeout(watch.paced))
      connection.watches.forEach((watch) => watch.entry.watches.delete(watch))
      if (closing && connections.size === 0) finish()
    })
    send(connection, { type: "hello", protocols: RunnerProtocol.SPOKEN, version: options.version, pid: process.pid })
  }

  function receive(connection: Connection, line: string) {
    const decoded = RunnerProtocol.decodeRequest(line)
    if (decoded._tag === "None") return fail(connection, null, "invalid", "invalid request", true)
    const request = decoded.value
    if (!connection.authenticated) {
      if (request.op !== "hello" || request.token !== token)
        return fail(connection, request.id, "auth", "authentication failed", true)
      if (!RunnerProtocol.SPOKEN.includes(request.protocol))
        return fail(connection, request.id, "protocol", `unsupported protocol ${request.protocol}`, true)
      connection.authenticated = true
      return send(connection, { id: request.id, type: "ok" })
    }
    if (request.op === "hello") return send(connection, { id: request.id, type: "ok" })
    if (request.op === "list")
      return send(connection, { id: request.id, type: "list", commands: [...entries.values()].map(describe) })
    if (request.op === "start") return start(connection, request.id, request.command)
    const entry = entries.get(request.command)
    if (!entry) return fail(connection, request.id, "unknown", `unknown command ${request.command}`)
    if (request.op === "watch") return watch(connection, request, entry)
    if (request.op === "deadline") {
      if (!entry.ended) arm(entry, request.deadline)
      return send(connection, { id: request.id, type: "command", command: describe(entry) })
    }
    if (request.remove) {
      entry.removed = true
      if (entry.exit) discard(entry)
    }
    if (!entry.ended) signal(entry, request.signal)
    return send(connection, { id: request.id, type: "ok" })
  }

  function start(connection: Connection, id: number, input: RunnerProtocol.Start) {
    const existing = entries.get(input.id)
    if (existing) return send(connection, { id, type: "started", command: describe(existing), existing: true })
    if (closing) return fail(connection, id, "closing", "the runner is exiting")
    clearTimeout(grace)
    const failed = (cause: unknown) => {
      writer?.close()
      guarded(`cannot remove the output of ${input.id}, which did not start`, () =>
        fs.rmSync(input.output, { force: true }),
      )
      fail(connection, id, "spawn", RunnerProtocol.messageOf(cause))
      rest()
    }
    let writer: RunnerOutput.Writer | undefined
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">
    try {
      fs.mkdirSync(path.dirname(input.output), { recursive: true })
      writer = new RunnerOutput.Writer(input.output, options.bounds)
      // Not node:child_process: in Bun it backs every chunk read from a pipe with a fresh 256 KiB buffer, and an
      // ended command leaves several times the garbage.
      child = Bun.spawn([...input.argv], {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (cause) {
      return failed(cause)
    }
    const output = writer
    const entry: Entry = {
      id: input.id,
      output: input.output,
      meta: input.meta,
      pid: child.pid,
      started: Date.now(),
      writer: output,
      watches: new Set(),
      deadline: null,
      removed: false,
      ended: false,
      lost: false,
    }
    entries.set(input.id, entry)
    arm(entry, input.deadline)
    const append = (chunk: Uint8Array) => {
      if (entry.ended) return
      // A full disk loses output, not the runner.
      try {
        output.append(chunk)
      } catch (cause) {
        if (!entry.lost)
          report(`cannot write the output of ${input.id}, so some of it is lost: ${RunnerProtocol.messageOf(cause)}`)
        entry.lost = true
      }
      // The chunk is in the file now. Detaching its buffer frees it at once; left to the collector, a flood of output
      // piles up tens of MB of buffers before a collection runs. Only a buffer the chunk has to itself.
      if (chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength)
        chunk.buffer.transfer(0)
      entry.watches.forEach((watch) => watch.output && !watch.paced && pump(watch))
    }
    const readers = [child.stdout.getReader(), child.stderr.getReader()]
    const drained = readers.map(async (reader) => {
      while (true) {
        const next = await reader.read().catch((cause: unknown) => {
          report(`cannot read the output of ${input.id}: ${RunnerProtocol.messageOf(cause)}`)
          return { done: true as const, value: undefined }
        })
        if (next.done) return
        append(next.value)
      }
    })
    let drain: ReturnType<typeof setTimeout> | undefined
    void child.exited.then(() => {
      clearTimeout(entry.deadlineTimer)
      // Pipes still held by the group's other processes are closed after a moment, so the command still ends.
      drain = setTimeout(
        () =>
          readers.forEach((reader) =>
            reader
              .cancel()
              .catch((cause: unknown) =>
                report(`cannot close the output of ${input.id}: ${RunnerProtocol.messageOf(cause)}`),
              ),
          ),
        DRAIN,
      )
      drain.unref()
    })
    void Promise.all([child.exited, ...drained]).then(() => {
      clearTimeout(drain)
      end(entry, { code: child.exitCode, signal: child.signalCode === null ? null : String(child.signalCode) })
      if (++endings % COLLECT_ENDED === 0) Bun.gc(true)
    })
    send(connection, { id, type: "started", command: describe(entry), existing: false })
  }

  function arm(entry: Entry, deadline: number | null) {
    clearTimeout(entry.deadlineTimer)
    entry.deadline = deadline
    if (deadline === null) return
    const wait = Math.min(Math.max(0, deadline - Date.now()), 2 ** 31 - 1)
    entry.deadlineTimer = setTimeout(() => {
      if (entry.ended || entry.deadline !== deadline) return
      if (Date.now() < deadline) return arm(entry, deadline)
      entry.reason ??= "timeout"
      signal(entry, "SIGTERM")
    }, wait)
  }

  function signal(entry: Entry, name: string) {
    if (name === "SIGTERM" || name === "SIGKILL") entry.reason ??= "killed"
    kill(entry, name)
    if (name !== "SIGTERM" || entry.killTimer) return
    // The group may outlive its leader, so the escalation does not depend on the leader still running.
    entry.killTimer = setTimeout(() => kill(entry, "SIGKILL"), killAfter)
    entry.killTimer.unref()
  }

  // A group that is gone already has nothing left to signal.
  function kill(entry: Entry, signal: string) {
    try {
      process.kill(-entry.pid, signal)
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
        report(`cannot send ${signal} to ${entry.id}: ${RunnerProtocol.messageOf(cause)}`)
    }
  }

  function end(entry: Entry, status: { code: number | null; signal: string | null }) {
    clearTimeout(entry.deadlineTimer)
    entry.ended = true
    const layout = finalize(entry)
    const exit: RunnerProtocol.Exit = {
      id: entry.id,
      status: entry.reason ?? "exited",
      ...(status.code !== null ? { code: status.code } : {}),
      ...(status.signal !== null ? { signal: status.signal } : {}),
      pid: entry.pid,
      started: entry.started,
      ended: Date.now(),
      size: entry.writer.size,
      lines: entry.writer.lines,
      ...(layout ? { layout } : {}),
      meta: entry.meta,
    }
    // Told once its exit file is written, so whoever hears of the end finds the file. One that can't be written is
    // reported and the end told all the same: its watchers get it, though a later service won't find the command.
    const written = entry.removed
      ? Promise.resolve()
      : RunnerOutput.writeAtomic(RunnerPaths.exit(entry.output), JSON.stringify(exit)).catch((cause: unknown) =>
          report(`cannot write the exit file of ${entry.id}: ${RunnerProtocol.messageOf(cause)}`),
        )
    void written.then(() => {
      entry.exit = exit
      if (entry.removed) discard(entry)
      entry.watches.forEach(pump)
      const exited = [...entries.values()].filter((item) => item.exit)
      exited.slice(0, -ENDED_LIMIT).forEach((item) => {
        item.writer.close()
        entries.delete(item.id)
      })
      rest()
    })
  }

  function finalize(entry: Entry) {
    try {
      return entry.writer.finish()
    } catch (cause) {
      report(
        `cannot put the output of ${entry.id} in order, so only its start can be read: ${RunnerProtocol.messageOf(cause)}`,
      )
      return entry.writer.layout
    }
  }

  function discard(entry: Entry) {
    entry.writer.close()
    guarded(`cannot remove the files of ${entry.id}`, () => {
      fs.rmSync(entry.output, { force: true })
      fs.rmSync(RunnerPaths.exit(entry.output), { force: true })
    })
  }

  function watch(connection: Connection, request: Extract<RunnerProtocol.Request, { op: "watch" }>, entry: Entry) {
    const item: Watch = {
      id: request.id,
      connection,
      entry,
      output: request.output,
      lag: request.lag,
      offset: request.offset,
      waiting: false,
    }
    connection.watches.set(request.id, item)
    entry.watches.add(item)
    send(connection, { id: request.id, type: "command", command: describe(entry) })
    pump(item)
  }

  function pump(watch: Watch) {
    const entry = watch.entry
    const socket = watch.connection.socket
    watch.waiting = false
    if (watch.output) {
      while (true) {
        if (socket.writableLength >= HIGH_WATER) {
          watch.waiting = true
          return
        }
        if (watch.lag !== undefined && entry.writer.size - watch.offset > watch.lag)
          watch.offset = entry.writer.size - watch.lag
        const chunk = entry.writer.read(watch.offset)
        if (!chunk || chunk.data.length === 0) break
        watch.offset = chunk.offset + chunk.data.length
        send(watch.connection, {
          id: watch.id,
          type: "output",
          offset: chunk.offset,
          data: chunk.data.toString("base64"),
          size: entry.writer.size,
        })
        if (watch.lag !== undefined) {
          watch.paced = setTimeout(() => {
            watch.paced = undefined
            pump(watch)
          }, PACE)
          return
        }
      }
    }
    if (!entry.exit) return
    send(watch.connection, { id: watch.id, type: "exit", exit: entry.exit })
    watch.connection.watches.delete(watch.id)
    entry.watches.delete(watch)
  }

  function describe(entry: Entry): RunnerProtocol.Command {
    return {
      id: entry.id,
      pid: entry.pid,
      pgid: entry.pid,
      started: entry.started,
      deadline: entry.deadline,
      output: entry.output,
      size: entry.writer.size,
      meta: entry.meta,
      ...(entry.removed ? { removed: true } : {}),
      ...(entry.exit ? { exit: entry.exit } : {}),
    }
  }

  function send(connection: Connection, frame: RunnerProtocol.Frame | RunnerProtocol.Hello) {
    if (connection.socket.destroyed) return
    connection.socket.write(JSON.stringify(frame) + "\n")
  }

  function fail(
    connection: Connection,
    id: number | null,
    code: RunnerProtocol.ErrorCode,
    message: string,
    hangUp = false,
  ) {
    send(connection, { id, type: "error", code, message })
    if (hangUp) connection.socket.end()
  }

  // Stop listening before anything else, so a client racing this exit starts a new runner instead of reaching
  // this one. Clients still connected get their last frames, then `bye`.
  function idle() {
    if (closing) return
    closing = true
    clearTimeout(grace)
    server.close()
    fs.rmSync(socketPath, { force: true })
    connections.forEach((connection) => {
      send(connection, { type: "bye" })
      connection.socket.end()
    })
    if (connections.size === 0) return finish()
    setTimeout(() => connections.forEach((connection) => connection.socket.destroy()), GOODBYE).unref()
  }

  let finished = false
  function finish() {
    if (finished) return
    finished = true
    entries.forEach((entry) => entry.writer.close())
    fs.rmSync(RunnerPaths.token(directory), { force: true })
    lock.release()
    resolveClosed()
  }

  return {
    pid: process.pid,
    directory,
    closed,
    shutdown: () => {
      stopping = true
      const running = [...entries.values()].filter((entry) => !entry.exit)
      if (running.length === 0) idle()
      running.filter((entry) => !entry.ended).forEach((entry) => signal(entry, "SIGTERM"))
      return closed
    },
  }
}

async function acquire(file: string, wait: number) {
  const deadline = Date.now() + wait
  while (true) {
    const lock = await RunnerLock.acquire(file)
    if (lock || Date.now() >= deadline) return lock
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY))
  }
}
