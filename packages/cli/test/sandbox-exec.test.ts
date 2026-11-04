import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Landlock } from "@opencode/sandbox/landlock"
import { Sandbox } from "@opencode/sandbox"
import { isolatedEnv } from "./fixture/environment"

const root = path.resolve(import.meta.dir, "../../..")
const cli = path.join(root, "packages/cli")

describe("sandbox-exec", () => {
  test("loads only the sandbox, so a sandboxed command doesn't wait for the CLI", async () => {
    const inputs = await bundleInputs("packages/cli/src/sandbox-exec.ts")
    expect(inputs.filter((input) => !input.startsWith("packages/sandbox/src/"))).toEqual([
      "packages/cli/src/sandbox-exec.ts",
    ])
    // The compiled binary's entry runs it before it imports the CLI.
    expect(await Bun.file(path.join(cli, "src/main.ts")).text()).toMatch(
      /^(\/\/.*\n)*import "\.\/sandbox-exec"\n\nawait import\("\.\/index"\)\n$/,
    )
  })

  // Confining needs Landlock; the sandbox package's tests cover the rules themselves.
  test.skipIf(!Sandbox.available().ok)("confines the command from both entries, then runs it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openforge-sandbox-exec-"))
    try {
      const policy = Landlock.encode({ write: ["/dev"], deny: [], network: true })
      const script = (name: string) => `echo x > ${path.join(home, name)} || echo refused; echo ran; exit 3`
      const results = await Promise.all(
        ["src/main.ts", "src/index.ts"].map(async (entry, index) => {
          const child = Bun.spawn(
            [process.execPath, entry, "sandbox-exec", policy, "--", "/bin/sh", "-c", script(String(index))],
            { cwd: cli, env: isolatedEnv(home), stdout: "pipe", stderr: "pipe" },
          )
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          return { code, stdout, denied: stderr.includes("Permission denied") }
        }),
      )
      expect(results).toEqual([
        { code: 3, stdout: "refused\nran\n", denied: true },
        { code: 3, stdout: "refused\nran\n", denied: true },
      ])
      expect(await fs.readdir(home)).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

async function bundleInputs(entrypoint: string) {
  const temporary = await fs.mkdtemp(path.join(import.meta.dir, ".sandbox-exec-"))
  const metafile = path.join(temporary, "meta.json")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        "--target=bun",
        "--format=esm",
        "--packages=bundle",
        `--metafile=${metafile}`,
        `--outdir=${path.join(temporary, "out")}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    const metadata = await Bun.file(metafile).json()
    return Object.keys(metadata.inputs).map((input) =>
      path.relative(root, path.resolve(root, input)).replaceAll(path.sep, "/"),
    )
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}
