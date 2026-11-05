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
    // The binary's entry evaluates nothing else first: the runner and the CLI are imported only after it.
    const entry = (await Bun.file(path.join(cli, "src/index.ts")).text()).replace(/^#!.*\n/, "")
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(entry)
    expect(imports.filter((item) => item.kind !== "dynamic-import").map((item) => item.path)).toEqual([
      "./sandbox-exec",
    ])
    expect(imports.filter((item) => item.kind === "dynamic-import").map((item) => item.path)).toEqual([
      "./runner",
      "./cli",
    ])
  })

  // Confining needs Landlock; the sandbox package's tests cover the rules themselves.
  test.skipIf(!Sandbox.available().ok)("confines the command, then runs it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openforge-sandbox-exec-"))
    try {
      const policy = Landlock.encode({ write: ["/dev"], deny: [], network: true })
      const child = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          "sandbox-exec",
          policy,
          "--",
          "/bin/sh",
          "-c",
          `echo x > ${path.join(home, "file")} || echo refused; echo ran; exit 3`,
        ],
        { cwd: cli, env: isolatedEnv(home), stdout: "pipe", stderr: "pipe" },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, denied: stderr.includes("Permission denied") }).toEqual({
        code: 3,
        stdout: "refused\nran\n",
        denied: true,
      })
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
