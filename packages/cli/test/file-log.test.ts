import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/schema/product"
import { Landlock } from "@opencode/sandbox/landlock"
import { Sandbox } from "@opencode/sandbox"
import { FileLog } from "../src/file-log"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv, stopLeftovers, transpilerCache } from "./fixture/environment"

// openforge (workspace task 92h1sva2hb2j): an agent's shell may not write openforge's data folder, where the file log
// is. A command that only asks the running service (`openforge cpp …` first), or prints help or the version, runs on
// without the file log when it can't open it; the service still fails at start, loudly. The CLI runs from source in an
// isolated home against a stand-in service.

const TOKEN = "file-log-test-token"
const PREFIX = "/api/experimental/pacer/inspect/"

let root = ""
let service: ReturnType<typeof Bun.serve> | undefined
const log = () => path.join(root, "data", Product.folder, "log")

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-file-log-"))
  service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const at = new URL(request.url)
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 })
      return new Response(`answer of ${at.pathname.slice(PREFIX.length)}\n`)
    },
  })
  await fs.mkdir(log(), { recursive: true })
  await Promise.all(["chat", "tmp", "cache"].map((folder) => fs.mkdir(path.join(root, folder))))
})

afterAll(async () => {
  await service?.stop(true)
  await fs.chmod(log(), 0o755)
  const leftovers = stopLeftovers(root)
  await fs.rm(root, { recursive: true, force: true })
  expect(leftovers).toEqual([])
})

/** Runs the CLI with `args` (after `prefix`, which may confine it) as a chat's command of the stand-in service. */
async function cli(args: string[], prefix: string[] = []) {
  const child = Bun.spawn(
    [...prefix, process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, {
        OPENCODE_SESSION_ID: "ses_file_log_test",
        OPENFORGE_CPP_URL: `http://127.0.0.1:${service?.port}`,
        OPENFORGE_CPP_TOKEN: TOKEN,
        TMPDIR: path.join(root, "tmp"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const deadline = setTimeout(() => child.kill("SIGKILL"), 25_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(deadline)
  return { stdout, stderr, exitCode }
}

describe("the file log", () => {
  test("is optional for a command that only asks the running service, or prints help or the version", () => {
    const optional = (line: string) => FileLog.optional(line.split(" ").filter(Boolean))
    expect(
      [
        "cpp projects",
        "cpp tasks theorysnap --state all",
        "--print-logs cpp read t1",
        "--version",
        "-v",
        "--help",
        "serve --help",
        "run -h",
        "models",
        "session list",
        "service status",
        "api GET /api/info",
      ].filter((line) => !optional(line)),
    ).toEqual([])
    // The service and what runs a server of its own, the TUI, a session run and what changes the install.
    expect(
      [
        "",
        "serve",
        "serve --service",
        ".",
        "--continue",
        "run hello",
        "mini",
        "acp",
        "upgrade",
        "uninstall --force",
        "notify",
        "models --standalone",
        "cpp projects --standalone",
      ].filter((line) => optional(line)),
    ).toEqual([])
  })

  // chmod keeps nobody out on Windows, and root out of nothing.
  describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("in a folder it can't write", () => {
    test(
      "a client command runs on without it: its normal output, nothing more, exit 0",
      async () => {
        await fs.chmod(log(), 0o555)
        try {
          const [projects, version] = await Promise.all([cli(["cpp", "projects"]), cli(["--version"])])
          expect(projects).toEqual({ stdout: "answer of projects\n", stderr: "", exitCode: 0 })
          expect(version).toEqual({ stdout: `${Product.binary} v${OPENCODE_VERSION}\n`, stderr: "", exitCode: 0 })
          expect(await fs.readdir(log())).toEqual([])
        } finally {
          await fs.chmod(log(), 0o755)
        }
      },
      { timeout: 60_000 },
    )

    test(
      "the service still fails at start and says why",
      async () => {
        await fs.chmod(log(), 0o555)
        try {
          const serve = await cli(["serve", "--hostname", "127.0.0.1", "--port", "0"])
          expect(serve.stderr).toContain("PermissionDenied")
          expect(serve.stderr).toContain(log())
          expect(serve.exitCode).toBe(1)
        } finally {
          await fs.chmod(log(), 0o755)
        }
      },
      { timeout: 60_000 },
    )
  })

  // The agents' sandbox (Sandbox.resolve's write list): the chat's folder, temp, the package caches and /dev; not
  // openforge's data, state or config folders. Confining needs Landlock.
  test.skipIf(!Sandbox.available().ok)(
    "a chat's `openforge cpp` works in the agents' sandbox, which may not write openforge's folders",
    async () => {
      const policy = Landlock.encode({
        write: [...["chat", "tmp", "cache"].map((folder) => path.join(root, folder)), transpilerCache, "/dev"],
        denyRead: [],
        network: true,
      })
      const sandboxed = await cli(
        ["cpp", "projects"],
        [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "sandbox-exec", policy, "--"],
      )
      expect(sandboxed).toEqual({ stdout: "answer of projects\n", stderr: "", exitCode: 0 })
    },
    { timeout: 60_000 },
  )
})
