export * as RunnerPaths from "./paths.js"

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

/** The folder holding one folder per release's runner, under openforge's state folder. */
export const root = (state: string) => path.join(state, "runner")

/** The runner folder of one release. */
export const directory = (state: string, version: string) => path.join(root(state), version.replace(/[^\w.-]/g, "_"))

export const lock = (directory: string) => path.join(directory, "lock")
export const token = (directory: string) => path.join(directory, "token")
export const log = (directory: string) => path.join(directory, "runner.log")

// Unix socket paths are limited to about 104 bytes. A folder too deep for one gets a socket in the temp folder,
// named after the folder, so the runner and its clients agree on it.
const SOCKET_LIMIT = 100

export function socket(directory: string) {
  const file = path.join(directory, "sock")
  if (Buffer.byteLength(file) <= SOCKET_LIMIT) return file
  return path.join(
    os.tmpdir(),
    `openforge-runner-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}.sock`,
  )
}

/** The exit file written next to a command's output file. */
export function exit(output: string) {
  return `${output.endsWith(".out") ? output.slice(0, -".out".length) : output}.exit`
}
