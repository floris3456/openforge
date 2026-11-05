// The sandbox proof as one program, so it also runs compiled where there is no Bun (the Mac):
//   proof run <root> [openforge]   sets up a fixture in <root> (outside every temp folder) and runs every scenario
//   proof bench <root> [openforge] the start-up cost of a sandboxed command against an unsandboxed one, for a home in
//                                  <root>; the folders on the way to it set how many Landlock rules there are
//   proof client <tcp|udp|udp6|unix> <host|path> [port]   one connection or datagram; exits 1 when refused
//   proof no-landlock <argv…>      runs argv where the kernel answers ENOSYS to every Landlock call
//   proof detect                   prints available() for this machine
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installFilter, noNewPrivileges } from "#native"
import { Landlock } from "../../src/landlock.js"
import { Sandbox } from "../../src/sandbox.js"
import { Seccomp } from "../../src/seccomp.js"
import { runAll, setup, spawn, type Launch } from "./scenarios.js"

// The benchmark's rounds, the rounds before them that aren't counted, and how often it times the policy's work.
const ROUNDS = 200
const WARMUP = 5
const PREPARATIONS = 200

// Compiled, argv[1] is the program inside the binary; from source, the script.
const [command, ...args] = process.argv.slice(2)
const tool = process.argv[1]?.endsWith(".ts") ? [process.execPath, process.argv[1]] : [process.execPath]

if (command === "client") process.exit(await client(args))
if (command === "no-landlock") noLandlock(args)
if (command === "detect") console.log(JSON.stringify(Sandbox.available()))
if (command === "run") process.exit(await run(args[0], args.slice(1)))
if (command === "bench") await bench(args[0], args.slice(1))

function launch(self: string[]): Launch {
  return { self: self.length ? self : [process.execPath, path.join(import.meta.dir, "sandbox-exec.ts")], tool }
}

async function run(root: string, self: string[]) {
  if (fs.existsSync(root)) throw new Error(`${root} exists`)
  fs.mkdirSync(root, { recursive: true })
  const fixture = await setup(fs.realpathSync(root))
  console.log(`platform ${process.platform} ${process.arch}, available ${JSON.stringify(Sandbox.available())}`)
  console.log(
    `sandbox-exec: ${process.platform === "darwin" ? "/usr/bin/sandbox-exec -p <profile>" : launch(self).self.join(" ")}`,
  )
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
  const outcome = await connect(kind, target, Number(port)).then(
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
  const ENOSYS = 38
  // landlock_create_ruleset, landlock_add_rule and landlock_restrict_self have the same numbers on every architecture.
  const calls = [444, 445, 446]
  noNewPrivileges()
  installFilter(
    Seccomp.assemble([
      Seccomp.load(Seccomp.Data.nr),
      ...calls.map((nr) => Seccomp.jeq(nr, "enosys")),
      Seccomp.ret(Seccomp.Action.allow),
      { ...Seccomp.ret(Seccomp.Action.errno | ENOSYS), label: "enosys" },
    ]),
  )
  process.execve!(argv[0], argv, process.env)
}

/**
 * Starts `/bin/sh -c true` unsandboxed and in each sandbox variant, one of each per round with the order turning, so
 * a change in the machine's load hits every variant alike. The cost of a variant is the median of its difference to
 * the unsandboxed start of the same round. "bare" is the sandbox's own process with nothing to enforce (an empty
 * Seatbelt profile, or a Landlock policy that allows everything), which splits that from the cost of the rules.
 */
async function bench(folder: string, self: string[]) {
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
  const sandbox = launch(self).self
  const shell = ["/bin/sh", "-c", "true"]
  const policy = Sandbox.resolve(undefined, context)
  const variants: Record<string, readonly string[]> = {
    unsandboxed: shell,
    bare:
      process.platform === "darwin"
        ? ["/usr/bin/sandbox-exec", "-p", "(version 1)\n(allow default)", ...shell]
        : [...sandbox, "sandbox-exec", Landlock.encode({ write: ["/"], denyRead: [], network: true }), "--", ...shell],
    sandboxed: wrapped(policy, shell, sandbox),
    "sandboxed, network off": wrapped(Sandbox.resolve({ network: false }, context), shell, sandbox),
  }
  const names = Object.keys(variants)
  const times = Object.fromEntries(names.map((name): [string, number[]] => [name, []]))
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
  for (let round = 0; round < WARMUP + ROUNDS; round++)
    for (const name of [...names.slice(round % names.length), ...names.slice(0, round % names.length)]) {
      const elapsed = await started(variants[name], { cwd: home, env })
      if (round >= WARMUP) times[name].push(elapsed)
    }
  // What the service does for each command before it starts it.
  const preparing = Array.from({ length: PREPARATIONS }, () => {
    const begun = performance.now()
    wrapped(Sandbox.resolve(undefined, context), shell, sandbox)
    return performance.now() - begun
  })
  fs.rmSync(folder, { recursive: true, force: true })

  const rules = Landlock.rules(policy).length
  console.log(`platform ${process.platform} ${process.arch}, ${os.cpus().length} cores, home ${home}`)
  const load = os.loadavg().map((value) => value.toFixed(2))
  console.log(`load average ${load.join(" ")} at the end`)
  console.log(
    process.platform === "darwin"
      ? `sandboxed with /usr/bin/sandbox-exec -p <profile>, ${variants.sandboxed[2].length} bytes`
      : `sandboxed with ${sandbox.join(" ")} sandbox-exec, ${rules} Landlock rules`,
  )
  console.log(`${ROUNDS} rounds; ms, median [10th-90th percentile]`)
  console.log(`${"".padEnd(24)} start                      cost (difference to unsandboxed, same round)`)
  for (const name of names) {
    const cost = times[name].map((value, index) => value - times.unsandboxed[index])
    console.log(`${name.padEnd(24)} ${spread(times[name]).padEnd(26)} ${name === "unsandboxed" ? "" : spread(cost)}`)
  }
  console.log(
    `${"working out the policy".padEnd(24)} ${spread(preparing)}  (Sandbox.resolve and wrap, in this process)`,
  )
}

function wrapped(policy: Sandbox.Policy, command: readonly string[], self: readonly string[]) {
  const result = Sandbox.wrap(policy, command, self)
  if (result.type !== "run" || !result.sandboxed) throw new Error("cannot sandbox here")
  return result.argv
}

async function started(argv: readonly string[], options: { cwd: string; env: Record<string, string> }) {
  const begun = performance.now()
  const result = await spawn(argv, options)
  const elapsed = performance.now() - begun
  if (result.code !== 0) throw new Error(`${argv[0]} exited ${result.code}: ${result.stderr}`)
  return elapsed
}

function spread(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return `${at(0.5).toFixed(2)} [${at(0.1).toFixed(2)}-${at(0.9).toFixed(2)}]`
}
