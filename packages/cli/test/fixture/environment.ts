import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/schema/product"

// Each isolated home gets its own XDG_CACHE_HOME, where Bun would otherwise keep its transpiler cache,
// so every spawned CLI process would transpile the source from scratch. Share one cache instead.
export const transpilerCache = path.join(os.tmpdir(), "opencode-test-transpiler-cache")

/**
 * First on every isolated PATH: an `openforge` that refuses to run, and notes each call in the home's
 * `openforge-from-path.log`. A test runs its own code (`process.execPath` and `src/index.ts`); one that ran
 * `openforge` by name, as `Service.ensure` does without a `command`, would run whatever release is installed on the
 * machine, and its service would outlive the test.
 */
export const testBin = path.join(os.tmpdir(), "opencode-test-bin")
export const fromPathLog = (root: string) => path.join(root, "openforge-from-path.log")

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  writeStandIn()
  // Windows spells it Path.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  return {
    ...process.env,
    [pathKey]: [testBin, process.env[pathKey]].filter(Boolean).join(path.delimiter),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
    HOME: root,
    OPENCODE_CLI_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}

/**
 * Stops every process still running from an isolated home, found by its OPENCODE_TEST_HOME, and answers what they
 * were, and each call of `openforge` from PATH, so the test that started them fails. Only Linux lists processes'
 * environments (/proc); elsewhere only the calls are found.
 */
export function stopLeftovers(root: string) {
  const calls = existsSync(fromPathLog(root))
    ? readFileSync(fromPathLog(root), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((args) => `ran ${Product.binary} from PATH: ${args}`)
    : []
  if (process.platform !== "linux") return calls
  const mark = `OPENCODE_TEST_HOME=${root}`
  const processes = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    .filter((pid) => readProc(pid, "environ").split("\0").includes(mark))
    .map((pid) => {
      const command = readProc(pid, "cmdline").replaceAll("\0", " ").trim()
      process.kill(Number(pid), "SIGKILL")
      return `${pid} ${command}`
    })
  return [...calls, ...processes]
}

// A process can end between listing and reading.
function readProc(pid: string, file: string) {
  try {
    return readFileSync(path.join("/proc", pid, file), "utf8")
  } catch {
    return ""
  }
}

function writeStandIn() {
  const windows = process.platform === "win32"
  const file = path.join(testBin, windows ? `${Product.binary}.cmd` : Product.binary)
  const message = `${Product.binary} from PATH in a test: a test runs its own code, never an installed release`
  const log = path.basename(fromPathLog(""))
  const script = windows
    ? `@if defined OPENCODE_TEST_HOME echo %*>> "%OPENCODE_TEST_HOME%\\${log}"\r\n@echo ${message} 1>&2\r\n@exit /b 1\r\n`
    : `#!/bin/sh\n[ -z "$OPENCODE_TEST_HOME" ] || echo "$*" >> "$OPENCODE_TEST_HOME/${log}"\necho "${message} ($*)" >&2\nexit 1\n`
  if (existsSync(file) && readFileSync(file, "utf8") === script) return
  mkdirSync(testBin, { recursive: true })
  // Written aside and renamed, so a test running alongside never finds half of it.
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, script, { mode: 0o755 })
  renameSync(temp, file)
}
