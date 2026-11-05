// A runner of protocol version 1, frozen as it went out with openforge 0.0.2: literal JSON lines, independent of
// src/protocol.ts. A later release that speaks a newer version still has to talk to this one, so this file and the
// test using it are never changed to follow the current protocol.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const command = (directory: string, deadline: number | null) => ({
  id: "sh_0123456789abFIXTURE00000",
  pid: 4242,
  pgid: 4242,
  started: 1_700_000_000_000,
  deadline,
  output: path.join(directory, "sh_0123456789abFIXTURE00000.out"),
  size: 11,
  meta: { command: "printf 'hello world'", shell: "/bin/sh" },
})

const exit = {
  id: "sh_0123456789abFIXTURE00000",
  status: "exited",
  code: 0,
  pid: 4242,
  started: 1_700_000_000_000,
  ended: 1_700_000_001_000,
  size: 11,
  lines: 0,
  meta: { command: "printf 'hello world'", shell: "/bin/sh" },
}

export async function serveV1(directory: string, protocols: number[] = [1]) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "token"), "v1-token", { mode: 0o600 })
  const requests: Record<string, unknown>[] = []
  let deadline: number | null = null
  const server = net.createServer((socket) => {
    const write = (value: unknown) => socket.write(JSON.stringify(value) + "\n")
    write({ type: "hello", protocols, version: "0.0.2", pid: 4242 })
    let pending = ""
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.on("data", (chunk: string) => {
      pending += chunk
      for (let index = pending.indexOf("\n"); index !== -1; index = pending.indexOf("\n")) {
        const request = JSON.parse(pending.slice(0, index))
        pending = pending.slice(index + 1)
        requests.push(request)
        if (request.op === "hello")
          write(
            request.token === "v1-token" && request.protocol === 1
              ? { id: request.id, type: "ok" }
              : { id: request.id, type: "error", code: "auth", message: "authentication failed" },
          )
        if (request.op === "start")
          write({
            id: request.id,
            type: "started",
            command: command(directory, request.command.deadline),
            existing: false,
          })
        if (request.op === "list") write({ id: request.id, type: "list", commands: [command(directory, deadline)] })
        if (request.op === "deadline") {
          deadline = request.deadline
          write({ id: request.id, type: "command", command: command(directory, deadline) })
        }
        if (request.op === "signal") write({ id: request.id, type: "ok" })
        if (request.op === "watch") {
          write({ id: request.id, type: "command", command: command(directory, deadline) })
          if (request.output) {
            write({
              id: request.id,
              type: "output",
              offset: 0,
              data: Buffer.from("hello ").toString("base64"),
              size: 6,
            })
            write({
              id: request.id,
              type: "output",
              offset: 6,
              data: Buffer.from("world").toString("base64"),
              size: 11,
            })
          }
          write({ id: request.id, type: "exit", exit })
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path.join(directory, "sock"), resolve))
  return {
    requests,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
