import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Landlock } from "../src/landlock.js"
import { Sandbox } from "../src/sandbox.js"
import { Seatbelt } from "../src/seatbelt.js"
import { Seccomp } from "../src/seccomp.js"

// Outside every temp folder, as a real home is.
const root = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dir, ".fixture-unit-")))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let count = 0
function folder() {
  const directory = path.join(root, String(count++))
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function touch(file: string, text = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function layout(base = folder()) {
  const home = path.join(base, "home")
  const project = path.join(home, "project")
  fs.mkdirSync(project, { recursive: true })
  return {
    base,
    home,
    project,
    context: {
      directory: project,
      home,
      data: path.join(home, ".local/share/openforge"),
      state: path.join(home, ".local/state/openforge"),
      config: path.join(home, ".config/openforge"),
      env: {},
    } satisfies Sandbox.Context,
  }
}

const policy = (input: Partial<Sandbox.Policy> = {}): Sandbox.Policy => ({
  mode: "write",
  network: true,
  required: false,
  write: ["/work/chat", "/tmp", "/dev"],
  denyRead: ["/home/u/.local/share/openforge/opencode.db"],
  platform: "linux",
  home: "/home/u",
  ...input,
})

describe("resolve", () => {
  test("write mode writes to the chat folder, its checkout, temp, existing caches, /dev and sandbox.write", () => {
    const fixture = layout()
    const checkout = path.join(fixture.base, "repo")
    const directory = path.join(checkout, "sub")
    const tmp = path.join(fixture.base, "tmp")
    const cargo = path.join(fixture.base, "cargo-home")
    for (const item of [directory, tmp, cargo, path.join(fixture.home, ".cache"), path.join(fixture.home, ".bun")])
      fs.mkdirSync(item, { recursive: true })
    const result = Sandbox.resolve(
      { write: ["~/extra", "relative/dir"] },
      {
        ...fixture.context,
        directory,
        worktree: checkout,
        env: { TMPDIR: tmp, CARGO_HOME: cargo, GOPATH: fixture.home, XDG_CACHE_HOME: "/" },
      },
    )
    expect(result.mode).toBe("write")
    expect(result.network).toBe(true)
    expect(result.required).toBe(false)
    expect(result.write).toEqual(
      expect.arrayContaining([
        directory,
        checkout,
        tmp,
        fs.realpathSync(os.tmpdir()),
        fs.realpathSync("/tmp"),
        path.join(fixture.home, ".cache"),
        path.join(fixture.home, ".bun"),
        cargo,
        "/dev",
        path.join(fixture.home, "extra"),
        path.join(directory, "relative/dir"),
      ]),
    )
    // Missing caches are left out; a variable naming the home folder or / would open all of it.
    expect(result.write).not.toContain(path.join(fixture.home, ".rustup"))
    expect(result.write).not.toContain(fixture.home)
    expect(result.write).not.toContain("/")
    expect(new Set(result.write).size).toBe(result.write.length)
  })

  test("adds a linked worktree's own and shared git folders when they are outside the chat folder", () => {
    const fixture = layout()
    const common = path.join(fixture.base, "main/.git")
    const own = path.join(common, "worktrees/wt")
    touch(path.join(own, "commondir"), "../..\n")
    const worktree = path.join(fixture.base, "wt")
    touch(path.join(worktree, ".git"), `gitdir: ${own}\n`)
    fs.mkdirSync(path.join(worktree, "sub"))
    const result = Sandbox.resolve(undefined, { ...fixture.context, directory: path.join(worktree, "sub") })
    expect(result.write).toEqual(expect.arrayContaining([path.join(worktree, "sub"), own, common]))

    // A checkout whose .git is inside the chat folder needs nothing more.
    fs.mkdirSync(path.join(fixture.project, ".git"))
    const plain = Sandbox.resolve(undefined, fixture.context)
    expect(plain.write.filter((item) => item.includes(".git"))).toEqual([])
  })

  test("denies reading openforge's credentials, its service passwords and deny_read", () => {
    const fixture = layout()
    const { data, state, config } = fixture.context
    const secrets = [
      touch(path.join(data, "opencode.db")),
      touch(path.join(data, "opencode-local.db")),
      touch(path.join(data, "opencode-local.db-wal")),
      touch(path.join(data, "auth.json")),
      touch(path.join(data, "releases/0.0.1/opencode.db")),
      touch(path.join(state, "service.json")),
      touch(path.join(state, "service-local.json")),
      touch(path.join(state, "service.json.pty-handoff")),
      touch(path.join(state, "runner/0.1.0/token")).replace(/\/0\.1\.0\/token$/, ""),
      path.join(state, "pty"),
      touch(path.join(config, "service.json")),
      path.join(data, "opencode.db-shm"),
      path.join(fixture.home, ".ssh"),
    ]
    const readable = [
      touch(path.join(data, "notes.txt")),
      touch(path.join(data, "releases/0.0.1/openforge")),
      touch(path.join(state, "kv.json")),
      touch(path.join(config, "opencode.json")),
    ]
    const result = Sandbox.resolve({ deny_read: ["~/.ssh"] }, fixture.context)
    expect(result.denyRead).toEqual(expect.arrayContaining(secrets))
    for (const item of readable) expect(result.denyRead).not.toContain(item)

    const moved = path.join(fixture.base, "elsewhere.db")
    expect(Sandbox.resolve(undefined, { ...fixture.context, database: moved }).denyRead).toEqual(
      expect.arrayContaining([moved, `${moved}-wal`, `${moved}-shm`]),
    )
  })

  test("read mode writes only to the temp folders and /dev; off mode has no lists", () => {
    const fixture = layout()
    fs.mkdirSync(path.join(fixture.home, ".cache"))
    const read = Sandbox.resolve({ mode: "read", network: false, required: true }, fixture.context)
    expect(read.write).not.toContain(fixture.project)
    expect(read.write).not.toContain(path.join(fixture.home, ".cache"))
    expect(read.write).toEqual(expect.arrayContaining([fs.realpathSync("/tmp"), "/dev"]))
    expect(read.denyRead.length).toBeGreaterThan(0)
    expect(read).toMatchObject({ mode: "read", network: false, required: true })
    expect(Sandbox.resolve({ mode: "off" }, fixture.context)).toMatchObject({ mode: "off", write: [], denyRead: [] })
  })
})

test("merge: the last mode, network and required set win, and paths add up", () => {
  expect(Sandbox.merge()).toBeUndefined()
  expect(Sandbox.merge(undefined, undefined)).toBeUndefined()
  expect(
    Sandbox.merge(
      { mode: "read", network: false, write: ["a"], deny_read: ["x"] },
      undefined,
      { mode: "write", write: ["b"], required: true },
      { network: true },
    ),
  ).toEqual({ mode: "write", network: true, write: ["a", "b"], deny_read: ["x"], required: true })
})

describe("wrap", () => {
  test("on Linux, starts openforge's sandbox-exec with the policy, then the command", () => {
    const result = Sandbox.wrap(policy({ network: false }), ["/bin/sh", "-c", "make"], ["/opt/openforge"], { ok: true })
    if (result.type !== "run") throw new Error(result.reason)
    expect(result.sandboxed).toBe(true)
    expect(result.argv.slice(0, 2)).toEqual(["/opt/openforge", "sandbox-exec"])
    expect(result.argv.slice(3)).toEqual(["--", "/bin/sh", "-c", "make"])
    expect(Landlock.decode(result.argv[2]!)).toEqual({
      write: ["/work/chat", "/tmp", "/dev"],
      deny: ["/home/u/.local/share/openforge/opencode.db"],
      network: false,
    })
  })

  test("on macOS, starts /usr/bin/sandbox-exec with the generated profile", () => {
    const result = Sandbox.wrap(policy({ platform: "darwin" }), ["/bin/zsh", "-c", "make"], ["/opt/openforge"], {
      ok: true,
    })
    expect(result).toEqual({
      type: "run",
      sandboxed: true,
      argv: [
        "/usr/bin/sandbox-exec",
        "-p",
        Seatbelt.profile({
          write: ["/work/chat", "/tmp", "/dev"],
          deny: ["/home/u/.local/share/openforge/opencode.db"],
          network: true,
        }),
        "/bin/zsh",
        "-c",
        "make",
      ],
    })
  })

  test("off mode runs the command as it is", () => {
    expect(Sandbox.wrap(policy({ mode: "off" }), ["make"], ["/opt/openforge"], { ok: true })).toEqual({
      type: "run",
      argv: ["make"],
      sandboxed: false,
    })
  })

  test("without a sandbox, runs unsandboxed and warns once, or refuses when the sandbox is required", () => {
    const machine = { ok: false, reason: "this kernel has no Landlock" } as const
    const first = Sandbox.wrap(policy(), ["make"], ["/opt/openforge"], machine)
    const second = Sandbox.wrap(policy(), ["make"], ["/opt/openforge"], machine)
    expect(first).toEqual({
      type: "run",
      argv: ["make"],
      sandboxed: false,
      warning: "This machine can't sandbox commands: this kernel has no Landlock. Commands run unsandboxed.",
    })
    expect(second).toEqual({ type: "run", argv: ["make"], sandboxed: false })
    expect(Sandbox.wrap(policy({ required: true }), ["make"], ["/opt/openforge"], machine)).toEqual({
      type: "refuse",
      reason:
        "This machine can't sandbox commands: this kernel has no Landlock. The command was not run, as sandbox.required is set.",
    })
  })
})

test("detect: Landlock 2 or later and seccomp on Linux, /usr/bin/sandbox-exec on macOS", () => {
  const probe = (landlock: number, seccomp = true, seatbelt = true) => ({
    landlock: () => landlock,
    seccomp: () => seccomp,
    seatbelt: () => seatbelt,
  })
  expect(Sandbox.detect("linux", probe(10))).toEqual({ ok: true, landlock: 10 })
  expect(Sandbox.detect("linux", probe(0))).toEqual({ ok: false, reason: "this kernel has no Landlock" })
  expect(Sandbox.detect("linux", probe(1))).toEqual({ ok: false, reason: "this kernel's Landlock (ABI 1) is too old" })
  expect(Sandbox.detect("linux", probe(6, false))).toEqual({ ok: false, reason: "this kernel has no seccomp filters" })
  expect(Sandbox.detect("darwin", probe(0))).toEqual({ ok: true })
  expect(Sandbox.detect("darwin", probe(0, false, false))).toEqual({
    ok: false,
    reason: "/usr/bin/sandbox-exec is missing",
  })
  expect(Sandbox.detect("win32", probe(10))).toEqual({ ok: false, reason: "there is no sandbox on win32" })
})

test("note: says where the command may write and how to run it outside the sandbox", () => {
  expect(Sandbox.note(policy({ write: ["/work/chat", "/home/u/.cache", "/dev"] }))).toBe(
    "This command ran in the sandbox, which lets it write only to /work/chat, ~/.cache, /dev. If the sandbox stopped it, run it again with `sandbox: false` (asks for the `unsandboxed` permission), or add the path to `sandbox.write` in the config.",
  )
  expect(Sandbox.note(policy({ network: false }))).toContain("/dev, and gives it no network.")
  expect(Sandbox.note(policy({ mode: "off" }))).toBeUndefined()
  expect(Sandbox.permission).toBe("unsandboxed")
})

describe("Landlock", () => {
  test("the policy survives encoding; anything else is refused", () => {
    const value = { write: ["/a b", "/dev"], deny: ["/c"], network: false }
    expect(Landlock.decode(Landlock.encode(value))).toEqual(value)
    const encoded = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url")
    expect(() => Landlock.decode(encoded({ ...value, v: 1, write: ["relative"] }))).toThrow("invalid sandbox policy")
    expect(() => Landlock.decode(encoded({ ...value, v: 2 }))).toThrow("invalid sandbox policy")
    expect(() => Landlock.decode(encoded({ v: 1, write: [], deny: [] }))).toThrow("invalid sandbox policy")
    expect(() => Landlock.decode("not base64 json")).toThrow()
  })

  test("reads everything except the denied paths by granting their siblings", () => {
    const base = folder()
    const key = touch(path.join(base, "secret/key"))
    const sibling = touch(path.join(base, "secret/public"))
    const nested = path.join(base, "secret/nested")
    fs.mkdirSync(nested)
    fs.symlinkSync(key, path.join(base, "secret/link"))
    const rules = Landlock.rules({ write: [], deny: [key], network: true })
    const access = (file: string) => rules.filter((rule) => rule.path === file).map((rule) => rule.access)
    const read = Landlock.Access.execute | Landlock.Access.readFile | Landlock.Access.readDir
    // The way from / to the denied file may only be listed.
    for (const ancestor of ["/", ...parents(path.join(base, "secret"))])
      expect(access(ancestor)).toEqual([Landlock.Access.readDir])
    expect(access(key)).toEqual([])
    expect(access(path.join(base, "secret/link"))).toEqual([])
    expect(access(sibling)).toEqual([Landlock.Access.execute | Landlock.Access.readFile])
    expect(access(nested)).toEqual([read])
    expect(access("/usr")).toEqual([read])
    expect(Landlock.rules({ write: [], deny: [], network: true })).toEqual([{ path: "/", access: read }])
  })

  test("writes beneath folders, to single files, and skips paths that don't exist", () => {
    const base = folder()
    const file = touch(path.join(base, "file"))
    const rules = Landlock.rules({ write: [base, file, path.join(base, "missing")], deny: [], network: true }).slice(1)
    expect(rules.map((rule) => rule.path)).toEqual([base, file])
    expect(rules[0]!.access & Landlock.Access.makeReg).toBe(Landlock.Access.makeReg)
    expect(rules[0]!.access & Landlock.Access.refer).toBe(Landlock.Access.refer)
    expect(rules[0]!.access & Landlock.Access.readFile).toBe(0n)
    expect(rules[1]!.access).toBe(Landlock.Access.writeFile | Landlock.Access.truncate | Landlock.Access.ioctlDev)
  })

  test("handles every filesystem right an ABI knows, except connecting to Unix sockets", () => {
    expect(Landlock.handled(1)).toBe(0x1fffn)
    expect(Landlock.handled(2)).toBe(0x3fffn)
    expect(Landlock.handled(4)).toBe(0x7fffn)
    expect(Landlock.handled(10)).toBe(0xffffn)
    expect(Landlock.network(3)).toBe(0n)
    expect(Landlock.network(4)).toBe(0x3n)
    expect(Landlock.network(10)).toBe(0xfn)
  })
})

describe("Seccomp", () => {
  const AF_UNIX = 1
  const AF_INET = 2
  const AF_INET6 = 10
  const ALLOW = 0x7fff0000
  const DENY = 0x00050000 | 13
  const run = (program: Uint8Array, arch: number, nr: number, domain = 0) => evaluate(program, { arch, nr, domain })

  test("x86_64: refuses IPv4 and IPv6 sockets in every ABI, and allows Unix sockets and other calls", () => {
    const program = Seccomp.network("x64")
    const x86_64 = 0xc000003e
    const i386 = 0x40000003
    expect(run(program, x86_64, 41, AF_INET)).toBe(DENY)
    expect(run(program, x86_64, 41, AF_INET6)).toBe(DENY)
    expect(run(program, x86_64, 41, AF_UNIX)).toBe(ALLOW)
    expect(run(program, x86_64, 0x40000000 | 41, AF_INET)).toBe(DENY)
    expect(run(program, x86_64, 42, AF_INET)).toBe(ALLOW)
    expect(run(program, x86_64, 0, AF_INET)).toBe(ALLOW)
    expect(run(program, i386, 359, AF_INET)).toBe(DENY)
    expect(run(program, i386, 359, AF_UNIX)).toBe(ALLOW)
    expect(run(program, i386, 102)).toBe(DENY)
    expect(run(program, i386, 3)).toBe(ALLOW)
    expect(run(program, 0xc00000b7, 198, AF_INET)).toBe(DENY)
  })

  test("aarch64: refuses IPv4 and IPv6 sockets, also from 32-bit programs", () => {
    const program = Seccomp.network("arm64")
    expect(run(program, 0xc00000b7, 198, AF_INET)).toBe(DENY)
    expect(run(program, 0xc00000b7, 198, AF_INET6)).toBe(DENY)
    expect(run(program, 0xc00000b7, 198, AF_UNIX)).toBe(ALLOW)
    expect(run(program, 0xc00000b7, 41, AF_INET)).toBe(ALLOW)
    expect(run(program, 0x40000028, 281, AF_INET)).toBe(DENY)
    expect(run(program, 0x40000028, 281, AF_UNIX)).toBe(ALLOW)
    expect(() => Seccomp.network("ia32")).toThrow()
  })
})

describe("Seatbelt", () => {
  test("allows by default and denies writes outside the write list and reads of the deny list", () => {
    expect(
      Seatbelt.profile({ write: ["/work/chat", "/private/tmp", "/dev"], deny: ["/Users/u/secret"], network: true }),
    ).toBe(
      [
        "(version 1)",
        "(allow default)",
        '(deny file-write* (require-not (require-any (subpath "/work/chat") (subpath "/private/tmp") (subpath "/dev"))))',
        '(deny file-read* (require-any (subpath "/Users/u/secret")))',
      ].join("\n"),
    )
  })

  test("denies IP networking when the network is off, which leaves Unix sockets alone", () => {
    const profile = Seatbelt.profile({ write: ["/dev"], deny: [], network: false })
    expect(profile).toContain('(deny network* (remote ip "*:*"))')
    expect(profile).toContain('(deny network* (local ip "*:*"))')
    expect(profile).not.toContain("file-read*")
    expect(profile).not.toContain("unix")
  })

  test("quotes paths, and denies every write when nothing is writable", () => {
    expect(Seatbelt.profile({ write: ['/a "b"\\c'], deny: [], network: true })).toContain('(subpath "/a \\"b\\"\\\\c")')
    expect(Seatbelt.profile({ write: [], deny: [], network: true }).split("\n")).toContain("(deny file-write*)")
  })
})

function parents(file: string) {
  const result = [file]
  while (path.dirname(result.at(-1)!) !== result.at(-1)) result.push(path.dirname(result.at(-1)!))
  return result.slice(0, -1)
}

/** Runs a classic BPF seccomp program on one call: loads, equality jumps, greater-or-equal jumps and returns. */
function evaluate(program: Uint8Array, call: { arch: number; nr: number; domain: number }) {
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength)
  const data = new DataView(new ArrayBuffer(64))
  data.setInt32(0, call.nr, true)
  data.setUint32(4, call.arch, true)
  data.setBigUint64(16, BigInt(call.domain), true)
  let accumulator = 0
  for (let pc = 0; pc * 8 < program.byteLength; pc++) {
    const code = view.getUint16(pc * 8, true)
    const jt = view.getUint8(pc * 8 + 2)
    const jf = view.getUint8(pc * 8 + 3)
    const k = view.getUint32(pc * 8 + 4, true)
    if (code === 0x20) accumulator = data.getUint32(k, true)
    else if (code === 0x15) pc += accumulator === k ? jt : jf
    else if (code === 0x35) pc += accumulator >= k ? jt : jf
    else if (code === 0x06) return k
    else throw new Error(`unknown instruction ${code}`)
  }
  throw new Error("the program fell off its end")
}
