// The sandbox's end-to-end cases, run against real sandboxed processes: where a command may write and read, its
// grandchildren, the network switched off, a git worktree, the read and off modes, what reaches the command, and
// failing closed without Landlock. `bun test` runs them on this machine, and the compiled proof binary (proof.ts) runs
// the same cases on Linux through the compiled openforge and on macOS.
import fs from "node:fs"
import path from "node:path"
import { Sandbox } from "../../src/sandbox.js"

export interface Launch {
  /** Starts openforge, whose `sandbox-exec` confines on Linux. */
  readonly self: Sandbox.Argv
  /** Starts proof.ts, for its `client` and `no-landlock` commands. */
  readonly tool: readonly string[]
}

export interface Fixture {
  readonly root: string
  readonly home: string
  readonly project: string
  readonly other: string
  readonly tmp: string
  readonly main: string
  readonly worktree: string
  readonly context: Sandbox.Context
  readonly env: Record<string, string>
}

export interface Scenario {
  readonly name: string
  readonly platforms?: readonly NodeJS.Platform[]
  /** The problems found; none means it passed. */
  readonly run: (fixture: Fixture, launch: Launch) => Promise<string[]>
}

const write = (file: string, text = "x\n") => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

export async function setup(root: string): Promise<Fixture> {
  const home = path.join(root, "home")
  const data = path.join(home, ".local/share/openforge")
  const state = path.join(home, ".local/state/openforge")
  const config = path.join(home, ".config/openforge")
  const tmp = path.join(root, "tmp")
  const project = path.join(home, "project")
  const other = path.join(home, "other")
  write(path.join(project, "README"))
  write(path.join(other, "existing"))
  write(path.join(home, ".cache/tool/keep"))
  write(path.join(home, "secret/key"), "secret\n")
  write(path.join(home, "secret/public"), "public\n")
  write(path.join(data, "opencode.db"), "credentials\n")
  write(path.join(data, "opencode.db-wal"), "credentials\n")
  write(path.join(data, "notes.txt"))
  write(path.join(data, "releases/0.1.0/opencode.db"), "credentials\n")
  write(path.join(data, "releases/0.1.0/openforge"))
  write(path.join(state, "service.json"), '{"password":"p"}\n')
  write(path.join(state, "runner/0.1.0/token"), "token\n")
  write(path.join(state, "kv.json"), "{}\n")
  write(path.join(config, "service.json"), '{"password":"p"}\n')
  write(path.join(config, "opencode.json"), "{}\n")
  fs.mkdirSync(tmp, { recursive: true })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C" }
  const main = path.join(root, "main")
  const worktree = path.join(root, "wt")
  await git(env, root, "init", "-q", project)
  await git(env, root, "init", "-q", "-b", "main", main)
  await git(env, main, "commit", "-q", "--allow-empty", "-m", "first")
  await git(env, main, "worktree", "add", "-q", "-b", "wt", worktree)
  return {
    root,
    home,
    project,
    other,
    tmp,
    main,
    worktree,
    env,
    context: { directory: project, home, data, state, config, env },
  }
}

async function git(env: Record<string, string>, cwd: string, ...args: string[]) {
  const result = await spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
}

export async function spawn(argv: readonly string[], options: { cwd: string; env: Record<string, string> }) {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** Runs each check (a shell command) in one sandboxed shell; each comes back "ok" or "refused". */
export async function probe(
  policy: Sandbox.Policy,
  fixture: Fixture,
  launch: Launch,
  checks: Record<string, string>,
  cwd = fixture.project,
) {
  const script = Object.entries(checks)
    .map(([name, command]) => `( ${command} ) >/dev/null 2>&1 && echo "${name}=ok" || echo "${name}=refused"`)
    .join("\n")
  const wrapped = Sandbox.wrap(policy, ["/bin/sh", "-c", script], launch.self, { ok: true })
  if (wrapped.type !== "run") throw new Error(wrapped.reason)
  const result = await spawn(wrapped.argv, { cwd, env: fixture.env })
  const found = Object.fromEntries(
    [...result.stdout.matchAll(/^(\w+)=(ok|refused)$/gm)].map((match): [string, string] => [match[1], match[2]]),
  )
  if (Object.keys(found).length !== Object.keys(checks).length)
    throw new Error(`sandboxed shell failed (${result.code}): ${result.stderr}`)
  return found
}

function compare(found: Record<string, string>, expected: Record<string, "ok" | "refused">) {
  return Object.entries(expected).flatMap(([name, value]) =>
    found[name] === value ? [] : [`${name}: expected ${value}, got ${found[name]}`],
  )
}

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const scenarios: Scenario[] = [
  {
    name: "writes inside the chat folder, the temp folder, a cache and /dev/null, and nowhere else",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve(undefined, fixture.context)
      const home = fixture.home
      const found = await probe(policy, fixture, launch, {
        chat: `cd ${q(fixture.project)} && echo x > made && cp made copy && : > copy && rm copy`,
        chatDir: `mkdir -p ${q(path.join(fixture.project, "a/b"))} && mv ${q(path.join(fixture.project, "made"))} ${q(path.join(fixture.project, "a/b/moved"))}`,
        temp: `echo x > "$TMPDIR/made"`,
        cache: `echo x > ${q(path.join(home, ".cache/tool/made"))}`,
        devNull: "echo x > /dev/null",
        home: `echo x > ${q(path.join(home, "made"))}`,
        otherProject: `echo x > ${q(path.join(fixture.other, "made"))}`,
        otherMkdir: `mkdir ${q(path.join(fixture.other, "dir"))}`,
        otherRemove: `rm ${q(path.join(fixture.other, "existing"))}`,
        otherTruncate: `: > ${q(path.join(fixture.other, "existing"))}`,
        moveOut: `echo x > "$TMPDIR/out" && mv "$TMPDIR/out" ${q(path.join(fixture.other, "out"))}`,
      })
      return [
        ...compare(found, {
          chat: "ok",
          chatDir: "ok",
          temp: "ok",
          cache: "ok",
          devNull: "ok",
          home: "refused",
          otherProject: "refused",
          otherMkdir: "refused",
          otherRemove: "refused",
          otherTruncate: "refused",
          moveOut: "refused",
        }),
        ...["made", "other/made", "other/dir", "other/out"]
          .filter((item) => fs.existsSync(path.join(home, item)))
          .map((item) => `~/${item} was written`),
        ...(fs.readFileSync(path.join(fixture.other, "existing"), "utf8") === "x\n"
          ? []
          : ["~/other/existing changed"]),
      ]
    },
  },
  {
    name: "refuses reading openforge's credentials and deny_read, and keeps their siblings readable",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve({ deny_read: ["~/secret/key"] }, fixture.context)
      const home = (item: string) => q(path.join(fixture.home, item))
      const found = await probe(policy, fixture, launch, {
        denied: `cat ${home("secret/key")}`,
        sibling: `cat ${home("secret/public")}`,
        listing: `ls ${home("secret")}`,
        database: `cat ${home(".local/share/openforge/opencode.db")}`,
        databaseWal: `cat ${home(".local/share/openforge/opencode.db-wal")}`,
        databaseCopy: `cat ${home(".local/share/openforge/releases/0.1.0/opencode.db")}`,
        releaseBinary: `cat ${home(".local/share/openforge/releases/0.1.0/openforge")}`,
        dataSibling: `cat ${home(".local/share/openforge/notes.txt")}`,
        registration: `cat ${home(".local/state/openforge/service.json")}`,
        runnerToken: `cat ${home(".local/state/openforge/runner/0.1.0/token")}`,
        stateSibling: `cat ${home(".local/state/openforge/kv.json")}`,
        serviceConfig: `cat ${home(".config/openforge/service.json")}`,
        config: `cat ${home(".config/openforge/opencode.json")}`,
        homeFile: `cat ${home("project/README")}`,
        system: "cat /etc/hosts",
      })
      return compare(found, {
        denied: "refused",
        sibling: "ok",
        listing: "ok",
        database: "refused",
        databaseWal: "refused",
        databaseCopy: "refused",
        releaseBinary: "ok",
        dataSibling: "ok",
        registration: "refused",
        runnerToken: "refused",
        stateSibling: "ok",
        serviceConfig: "refused",
        config: "ok",
        homeFile: "ok",
        system: "ok",
      })
    },
  },
  {
    name: "refuses reading the database copies a switch makes while a command runs",
    run: async (fixture, launch) => {
      const data = path.join(fixture.home, ".local/share/openforge")
      // A release openforge has not switched away from yet: no copy in its folder when the command starts.
      write(path.join(data, "releases/0.2.0/openforge"))
      const policy = Sandbox.resolve(undefined, fixture.context)
      const started = path.join(fixture.tmp, "copies.started")
      const copied = path.join(fixture.tmp, "copies.made")
      const copy = path.join(data, "releases/0.2.0/opencode.db")
      const probing = probe(policy, fixture, launch, {
        started: `: > ${q(started)}`,
        // As a command that runs through a switch: the copies appear while it runs.
        waited: `while [ ! -e ${q(copied)} ]; do sleep 0.01; done`,
        copy: `cat ${q(copy)}`,
        partial: `cat ${q(`${copy}.partial`)}`,
        restore: `cat ${q(path.join(data, "opencode.db.restore"))}`,
        releaseBinary: `cat ${q(path.join(data, "releases/0.2.0/openforge"))}`,
      })
      const made = [copy, `${copy}.partial`, path.join(data, "opencode.db.restore")]
      try {
        // No event says the sandboxed shell has started; it leaves a file.
        const deadline = Date.now() + 10_000
        while (!fs.existsSync(started) && Date.now() < deadline) await Bun.sleep(10)
        for (const file of made) write(file, "credentials\n")
        write(copied)
        return compare(await probing, {
          started: "ok",
          waited: "ok",
          copy: "refused",
          partial: "refused",
          restore: "refused",
          releaseBinary: "ok",
        })
      } finally {
        write(copied)
        await probing.catch(() => undefined)
        for (const file of [...made, started, copied]) fs.rmSync(file, { force: true })
        fs.rmSync(path.join(data, "releases/0.2.0"), { recursive: true, force: true })
      }
    },
  },
  {
    name: "confines grandchildren, also those that outlive the command",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve(undefined, fixture.context)
      const target = path.join(fixture.home, "grandchild")
      const later = path.join(fixture.home, "later")
      const result = path.join(fixture.tmp, "later.result")
      // The grandchild writes to $F, which every shell on the way inherits.
      const grandchild = (file: string) => `F=${q(file)} sh -c 'sh -c "echo x > \\"\\$F\\""'`
      const found = await probe(policy, fixture, launch, {
        grandchild: grandchild(target),
        grandchildChat: grandchild(path.join(fixture.project, "grandchild")),
        detached: `(sleep 0.2; (echo x > ${q(later)} && echo ok || echo refused) > ${q(result)} 2>/dev/null) </dev/null >/dev/null 2>&1 & true`,
        ...(process.platform === "linux" ? { setsid: `F=${q(target)} setsid sh -c 'echo x > "$F"'` } : {}),
      })
      const deadline = Date.now() + 10_000
      while (!fs.existsSync(result) || fs.readFileSync(result, "utf8") === "") {
        if (Date.now() > deadline) return ["the detached grandchild never reported"]
        await Bun.sleep(20)
      }
      return [
        ...compare(found, { grandchild: "refused", grandchildChat: "ok", detached: "ok" }),
        ...(found.setsid === undefined || found.setsid === "refused" ? [] : ["setsid: expected refused"]),
        ...(fs.readFileSync(result, "utf8").trim() === "refused" ? [] : ["the detached grandchild could write to ~"]),
        ...(fs.existsSync(target) ? ["~/grandchild was written"] : []),
        ...(fs.existsSync(later) ? ["~/later was written"] : []),
      ]
    },
  },
  {
    name: "with the network off, refuses TCP and UDP over IPv4 and IPv6, and keeps Unix sockets",
    run: async (fixture, launch) => {
      const received = { tcp: 0, udp: 0, unix: 0 }
      const tcp = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data: () => void received.tcp++ },
      })
      const udp = await Bun.udpSocket({ hostname: "127.0.0.1", socket: { data: () => void received.udp++ } })
      const socket = path.join(fixture.tmp, "s.sock")
      const unix = Bun.listen({ unix: socket, socket: { data: () => void received.unix++ } })
      const client = (...args: string[]) => [...launch.tool, "client", ...args].map(q).join(" ")
      const checks = {
        tcp: client("tcp", "127.0.0.1", String(tcp.port)),
        udp: client("udp", "127.0.0.1", String(udp.port)),
        udp6: client("udp6", "::1", String(udp.port)),
        unix: client("unix", socket),
      }
      const open = await probe(Sandbox.resolve(undefined, fixture.context), fixture, launch, checks)
      const counted = { ...received }
      const closed = await probe(Sandbox.resolve({ network: false }, fixture.context), fixture, launch, checks)
      const after = { ...received }
      tcp.stop(true)
      udp.close()
      unix.stop(true)
      return [
        ...compare(open, { tcp: "ok", udp: "ok", udp6: "ok", unix: "ok" }).map((problem) => `network on: ${problem}`),
        ...compare(closed, { tcp: "refused", udp: "refused", udp6: "refused", unix: "ok" }).map(
          (problem) => `network off: ${problem}`,
        ),
        ...(counted.tcp > 0 && counted.udp > 0 ? [] : [`network on: the servers received ${JSON.stringify(counted)}`]),
        ...(after.tcp === counted.tcp && after.udp === counted.udp
          ? []
          : [`network off: the servers still received ${JSON.stringify(after)}`]),
      ]
    },
  },
  {
    name: "commits in a git worktree whose shared .git is outside the chat folder",
    run: async (fixture, launch) => {
      const context = { ...fixture.context, directory: fixture.worktree }
      const policy = Sandbox.resolve(undefined, context)
      const common = fs.realpathSync(path.join(fixture.main, ".git"))
      const own = path.join(common, "worktrees", path.basename(fixture.worktree))
      const without = { ...policy, write: policy.write.filter((item) => !item.startsWith(common)) }
      const commit = (message: string) =>
        `git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m ${message}`
      const found = await probe(policy, fixture, launch, { commit: commit("sandboxed") }, fixture.worktree)
      const refused = await probe(without, fixture, launch, { commit: commit("unwritable") }, fixture.worktree)
      const log = await spawn(["git", "log", "--format=%s", "wt"], { cwd: fixture.main, env: fixture.env })
      return [
        ...[common, own].filter((item) => !policy.write.includes(item)).map((item) => `${item} is not writable`),
        ...compare(found, { commit: "ok" }),
        ...compare(refused, { commit: "refused" }).map((problem) => `without the git folders: ${problem}`),
        ...(log.stdout.split("\n").includes("sandboxed") ? [] : ["the commit is not in the shared repository"]),
      ]
    },
  },
  {
    name: "read mode writes only to the temp folder",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve({ mode: "read" }, fixture.context)
      const found = await probe(policy, fixture, launch, {
        chat: `echo x > ${q(path.join(fixture.project, "read-mode"))}`,
        cache: `echo x > ${q(path.join(fixture.home, ".cache/tool/read-mode"))}`,
        temp: `echo x > "$TMPDIR/read-mode"`,
        devNull: "echo x > /dev/null",
        read: `cat ${q(path.join(fixture.project, ".git/HEAD"))}`,
      })
      return compare(found, { chat: "refused", cache: "refused", temp: "ok", devNull: "ok", read: "ok" })
    },
  },
  {
    name: "off mode runs the same writes and reads unsandboxed",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve({ mode: "off", deny_read: ["~/secret/key"] }, fixture.context)
      const made = [path.join(fixture.home, "off-mode"), path.join(fixture.other, "off-mode")]
      const found = await probe(policy, fixture, launch, {
        home: `echo x > ${q(made[0])}`,
        otherProject: `echo x > ${q(made[1])}`,
        denied: `cat ${q(path.join(fixture.home, "secret/key"))}`,
      })
      for (const file of made) fs.rmSync(file, { force: true })
      return compare(found, { home: "ok", otherProject: "ok", denied: "ok" })
    },
  },
  {
    name: "passes the environment, the exit code and default signal handling to the command",
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve(undefined, fixture.context)
      const script = [
        'echo "home=$HOME"',
        process.platform === "linux" ? "grep SigIgn /proc/self/status" : "true",
        "yes | head -c 2 >/dev/null",
        "exit 7",
      ].join("\n")
      const wrapped = Sandbox.wrap(policy, ["/bin/sh", "-c", script], launch.self, { ok: true })
      if (wrapped.type !== "run") return [wrapped.reason]
      const result = await spawn(wrapped.argv, { cwd: fixture.project, env: fixture.env })
      const absent = Sandbox.wrap(policy, ["no-such-command-here"], launch.self, { ok: true })
      if (absent.type !== "run") return [absent.reason]
      const missing = await spawn(absent.argv, { cwd: fixture.project, env: fixture.env })
      return [
        ...(result.code === 7 ? [] : [`exit code ${result.code}, stderr ${result.stderr}`]),
        ...(result.stdout.includes(`home=${fixture.home}`) ? [] : ["HOME did not pass"]),
        ...(process.platform !== "linux" || /SigIgn:\s+0+\n/.test(result.stdout)
          ? []
          : [`ignored signals passed on: ${result.stdout}`]),
        // Apple's sandbox-exec exits 71 for a program it can't find; ours exits 127, as a shell does.
        ...(missing.code === (process.platform === "darwin" ? 71 : 127)
          ? []
          : [`a missing command exited ${missing.code}`]),
      ]
    },
  },
  {
    name: "fails closed when the kernel has no Landlock",
    platforms: ["linux"],
    run: async (fixture, launch) => {
      const policy = Sandbox.resolve(undefined, fixture.context)
      const marker = path.join(fixture.home, "unconfined")
      const wrapped = Sandbox.wrap(policy, ["/bin/sh", "-c", `echo x > ${q(marker)}`], launch.self, { ok: true })
      if (wrapped.type !== "run") return [wrapped.reason]
      const result = await spawn([...launch.tool, "no-landlock", ...wrapped.argv], {
        cwd: fixture.project,
        env: fixture.env,
      })
      const detected = await spawn([...launch.tool, "no-landlock", ...launch.tool, "detect"], {
        cwd: fixture.project,
        env: fixture.env,
      })
      return [
        ...(result.code === 125 && result.stderr.includes("no Landlock")
          ? []
          : [`exit ${result.code}: ${result.stderr}`]),
        ...(fs.existsSync(marker) ? ["the command ran unconfined"] : []),
        ...(detected.stdout.includes('"ok":false') && detected.stdout.includes("no Landlock")
          ? []
          : [`available() reported ${detected.stdout} ${detected.stderr}`]),
      ]
    },
  },
]

export async function runAll(fixture: Fixture, launch: Launch, report: (line: string) => void) {
  const failed: string[] = []
  for (const scenario of scenarios.filter((item) => !item.platforms || item.platforms.includes(process.platform))) {
    const problems = await scenario.run(fixture, launch).catch((error: unknown) => [String(error)])
    report(`${problems.length === 0 ? "PASS" : "FAIL"}  ${scenario.name}`)
    for (const problem of problems) report(`        ${problem}`)
    if (problems.length > 0) failed.push(scenario.name)
  }
  return failed
}
