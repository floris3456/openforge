import { expect, test } from "bun:test"
import path from "node:path"
import { Product } from "@opencode/schema/product"
import { fromPathLog, isolatedEnv, testBin } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

// A test that runs `openforge` by name must not reach an installed release: its service would outlive the test.

test("openforge on an isolated PATH is a stand-in that refuses to run", async () => {
  await using dir = await tmpdir()
  const env = isolatedEnv(dir.path)
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  const found = Bun.which(Product.binary, { PATH: env[pathKey] })
  expect(found).toBe(path.join(testBin, process.platform === "win32" ? `${Product.binary}.cmd` : Product.binary))
  // Windows runs a .cmd only through cmd.exe; finding it first is the guard there.
  if (process.platform === "win32") return
  const child = Bun.spawn([Product.binary, "serve", "--service"], { env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr: stderr.trim() }).toEqual({
    code: 1,
    stdout: "",
    stderr: `${Product.binary} from PATH in a test: a test runs its own code, never an installed release (serve --service)`,
  })
  // So a test whose code tried it can fail on it even when the attempt's failure is handled.
  expect(await Bun.file(fromPathLog(dir.path)).text()).toBe("serve --service\n")
})
