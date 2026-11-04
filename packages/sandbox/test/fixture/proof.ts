// The sandbox proof as one program, so it also runs compiled where there is no Bun (the Mac):
//   proof run <root> [openforge]   sets up a fixture in <root> (outside every temp folder) and runs every scenario
//   proof bench <root> [openforge] the median start-up cost of a sandboxed command against an unsandboxed one, for a
//                                  home in <root>; the folders on the way to it set how many Landlock rules there are
//   proof client <tcp|udp|udp6|unix> <host|path> [port]   one connection or datagram; exits 1 when refused
//   proof no-landlock <argv…>      runs argv where the kernel answers ENOSYS to every Landlock call
//   proof detect                   prints available() for this machine
import fs from "node:fs"
import path from "node:path"
import { installFilter } from "#native"
import { Landlock } from "../../src/landlock.js"
import { Sandbox } from "../../src/sandbox.js"
import { runAll, setup, spawn, type Launch } from "./scenarios.js"

// Compiled, argv[1] is the program inside the binary; from source, the script.
const [command, ...args] = process.argv.slice(2)
const tool = process.argv[1]?.endsWith(".ts") ? [process.execPath, process.argv[1]] : [process.execPath]

if (command === "client") process.exit(await client(args))
if (command === "no-landlock") noLandlock(args)
if (command === "detect") console.log(JSON.stringify(Sandbox.available()))
if (command === "run") process.exit(await run(args[0]!, args.slice(1)))
if (command === "bench") await bench(args[0]!, args.slice(1))

function launch(self: string[]): Launch {
  return { self: self.length ? self : [process.execPath, path.join(import.meta.dir, "sandbox-exec.ts")], tool }
}

async function run(root: string, self: string[]) {
  if (fs.existsSync(root)) throw new Error(`${root} exists`)
  fs.mkdirSync(root, { recursive: true })
  const fixture = await setup(fs.realpathSync(root))
  console.log(`platform ${process.platform} ${process.arch}, available ${JSON.stringify(Sandbox.available())}`)
  console.log(`sandbox-exec: ${process.platform === "darwin" ? "/usr/bin/sandbox-exec -p <profile>" : launch(self).self.join(" ")}`)
  const policy = Sandbox.resolve({ deny_read: ["~/secret/key"] }, fixture.context)
  const wrapped = Sandbox.wrap(policy, ["/bin/sh", "-c", "make"], launch(self).self)
  console.log(`the chat folder's policy, with deny_read ["~/secret/key"]:\n${JSON.stringify(policy, null, 2)}`)
  if (wrapped.type === "run" && process.platform === "darwin") console.log(`its profile:\n${wrapped.argv[2]}`)
  if (wrapped.type === "run" && process.platform !== "darwin") console.log(`its argv: ${JSON.stringify(wrapped.argv)}`)
  console.log(`its note: ${Sandbox.note(policy)}\n`)
  const failed = await runAll(fixture, launch(self), (line) => console.log(line))
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed.length === 0 ? "all passed" : `${failed.length} failed`)
  return failed.length === 0 ? 0 : 1
}

async function client(args: string[]) {
  const [kind, target, port] = args
  const outcome = await connect(kind!, target!, Number(port)).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  if (outcome) console.error(outcome)
  return outcome ? 1 : 0
}

async function connect(kind: string, target: string, port: number) {
  if (kind === "udp" || kind === "udp6") {
    const socket = await Bun.udpSocket({ hostname: kind === "udp6" ? "::" : "0.0.0.0" })
    const sent = socket.send("x", port, target)
    socket.close()
    if (!sent) throw new Error("not sent")
    return
  }
  const handlers = { data: () => {} }
  const socket = await (kind === "unix"
    ? Bun.connect({ unix: target, socket: handlers })
    : Bun.connect({ hostname: target, port, socket: handlers }))
  socket.write("x")
  socket.flush()
  socket.end()
}

function noLandlock(argv: string[]) {
  // seccomp: on this architecture, landlock_create_ruleset, _add_rule and _restrict_self (444-446) return ENOSYS.
  const arch = process.arch === "arm64" ? 0xc00000b7 : 0xc000003e
  const ENOSYS = 38
  const lines = [
    [0x20, 0, 0, 4],
    [0x15, 0, 4, arch],
    [0x20, 0, 0, 0],
    [0x35, 0, 2, 444], // jge 444
    [0x35, 1, 0, 447], // jge 447 → allow
    [0x06, 0, 0, 0x00050000 | ENOSYS],
    [0x06, 0, 0, 0x7fff0000],
  ]
  const program = new Uint8Array(lines.length * 8)
  const view = new DataView(program.buffer)
  lines.forEach(([code, jt, jf, k], index) => {
    view.setUint16(index * 8, code!, true)
    view.setUint8(index * 8 + 2, jt!)
    view.setUint8(index * 8 + 3, jf!)
    view.setUint32(index * 8 + 4, k!, true)
  })
  installFilter(program)
  process.execve!(argv[0]!, argv, process.env)
}

async function bench(folder: string, self: string[]) {
  const runs = 50
  if (fs.existsSync(folder)) throw new Error(`${folder} exists`)
  fs.mkdirSync(folder, { recursive: true })
  const home = path.join(fs.realpathSync(folder), "home")
  const context = {
    directory: path.join(home, "project"),
    home,
    data: path.join(home, ".local/share/openforge"),
    state: path.join(home, ".local/state/openforge"),
    config: path.join(home, ".config/openforge"),
  }
  for (const file of [path.join(context.data, "opencode.db"), path.join(context.state, "service.json")]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "")
  }
  fs.mkdirSync(context.directory, { recursive: true })
  const policy = Sandbox.resolve(undefined, context)
  const command = ["/bin/sh", "-c", "true"]
  const variants = {
    unsandboxed: command,
    sandboxed: wrapped(policy, command, launch(self).self),
    "sandboxed, network off": wrapped(Sandbox.resolve({ network: false }, context), command, launch(self).self),
  }
  const medians: Record<string, number> = {}
  for (const [name, argv] of Object.entries(variants)) medians[name] = await median(argv, runs, home)
  fs.rmSync(folder, { recursive: true, force: true })
  const rules = Landlock.rules({ write: policy.write, deny: policy.denyRead, network: true }).length
  console.log(`platform ${process.platform} ${process.arch}, home ${home}, ${runs} runs each`)
  console.log(
    process.platform === "darwin"
      ? "sandboxed with /usr/bin/sandbox-exec -p <profile>"
      : `sandboxed with ${launch(self).self.join(" ")} sandbox-exec, ${rules} Landlock rules`,
  )
  for (const [name, value] of Object.entries(medians))
    console.log(`${name.padEnd(24)} median ${value.toFixed(2)} ms  (+${(value - medians.unsandboxed!).toFixed(2)} ms)`)
}

function wrapped(policy: Sandbox.Policy, command: string[], self: readonly string[]) {
  const result = Sandbox.wrap(policy, command, self)
  if (result.type !== "run" || !result.sandboxed) throw new Error("cannot sandbox here")
  return result.argv
}

async function median(argv: string[], runs: number, home: string) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
  const times: number[] = []
  for (let index = 0; index < runs + 5; index++) {
    const started = performance.now()
    const result = await spawn(argv, { cwd: home, env })
    const elapsed = performance.now() - started
    if (result.code !== 0) throw new Error(`${argv[0]} exited ${result.code}: ${result.stderr}`)
    if (index >= 5) times.push(elapsed)
  }
  times.sort((left, right) => left - right)
  return times[Math.floor(times.length / 2)]!
}
