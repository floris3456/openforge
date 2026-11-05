export * as Landlock from "./landlock.js"

import fs from "node:fs"
import path from "node:path"
import { addPathRule, createRuleset, installFilter, landlock, noNewPrivileges, restrictSelf } from "#native"
import { entries } from "./files.js"
import type { Sandbox } from "./sandbox.js"
import { Seccomp } from "./seccomp.js"

// Landlock only grants. Every filesystem right the kernel knows is handled, so anything not granted is refused:
// reading is granted on everything except the denied paths, writing only beneath the write list.

/** LANDLOCK_ACCESS_FS_*. */
export const Access = {
  execute: 1n << 0n,
  writeFile: 1n << 1n,
  readFile: 1n << 2n,
  readDir: 1n << 3n,
  removeDir: 1n << 4n,
  removeFile: 1n << 5n,
  makeChar: 1n << 6n,
  makeDir: 1n << 7n,
  makeReg: 1n << 8n,
  makeSock: 1n << 9n,
  makeFifo: 1n << 10n,
  makeBlock: 1n << 11n,
  makeSym: 1n << 12n,
  refer: 1n << 13n,
  truncate: 1n << 14n,
  ioctlDev: 1n << 15n,
} as const

/** LANDLOCK_ACCESS_NET_*. */
const Net = {
  bindTcp: 1n << 0n,
  connectTcp: 1n << 1n,
  bindUdp: 1n << 2n,
  connectSendUdp: 1n << 3n,
} as const

/** ABI 1 has no `refer` right, so it refuses every rename or link between folders. */
const MINIMUM_ABI = 2
/** The version of what `encode` writes. */
const FORMAT = 1

const read = Access.execute | Access.readFile | Access.readDir
const readFile = Access.execute | Access.readFile
const writeFile = Access.writeFile | Access.truncate | Access.ioctlDev
const write =
  writeFile |
  Access.removeDir |
  Access.removeFile |
  Access.makeChar |
  Access.makeDir |
  Access.makeReg |
  Access.makeSock |
  Access.makeFifo |
  Access.makeBlock |
  Access.makeSym |
  Access.refer

export interface Rule {
  readonly path: string
  readonly access: bigint
}

/** Why this kernel's Landlock (`abi`, 0 for none) can't confine a command; undefined when it can. */
export function unsupported(abi: number) {
  if (abi === 0) return "this kernel has no Landlock"
  if (abi < MINIMUM_ABI) return `this kernel's Landlock (ABI ${abi}) is too old (needs ${MINIMUM_ABI})`
  return undefined
}

/**
 * The filesystem rights a supported ABI knows: `truncate` comes with ABI 3 and `ioctlDev` with 5. ABI 9's right to
 * reach Unix sockets by path is left alone, so they keep working.
 */
export function handled(abi: number) {
  const upTo = (right: bigint) => (right << 1n) - 1n
  if (abi >= 5) return upTo(Access.ioctlDev)
  if (abi >= 3) return upTo(Access.truncate)
  return upTo(Access.refer)
}

/** The network rights an ABI knows: TCP bind and connect from ABI 4, UDP bind and send from ABI 10. */
export function network(abi: number) {
  if (abi >= 10) return Net.bindTcp | Net.connectTcp | Net.bindUdp | Net.connectSendUdp
  if (abi >= 4) return Net.bindTcp | Net.connectTcp
  return 0n
}

/** What `openforge sandbox-exec` receives. */
export function encode(policy: Sandbox.Confinement) {
  const value = { v: FORMAT, write: policy.write, denyRead: policy.denyRead, network: policy.network }
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

export function decode(text: string): Sandbox.Confinement {
  const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString())
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== FORMAT ||
    !("write" in value) ||
    !paths(value.write) ||
    !("denyRead" in value) ||
    !paths(value.denyRead) ||
    !("network" in value) ||
    typeof value.network !== "boolean"
  )
    throw new Error("invalid sandbox policy")
  return { write: value.write, denyRead: value.denyRead, network: value.network }
}

function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && path.isAbsolute(item))
}

/**
 * The rules for a policy. Reading everything except the denied paths is built by granting, along the way from / to
 * each denied path, every sibling of that way; the folders on the way may only be listed. So a file created later in
 * one of those folders is readable only from the next command on.
 */
export function rules(policy: Sandbox.Confinement): Rule[] {
  return [...readRules(policy.denyRead), ...policy.write.flatMap(writeRule)]
}

/** Confines this thread for good: Landlock, plus seccomp when the network is off. Both pass on to what it execs. */
export function confine(policy: Sandbox.Confinement) {
  const abi = landlock()
  const problem = unsupported(abi)
  if (problem) throw new Error(problem)
  const rights = handled(abi)
  const ruleset = createRuleset(rights, policy.network ? 0n : network(abi))
  for (const rule of rules(policy)) addPathRule(ruleset, rule.path, rule.access & rights)
  noNewPrivileges()
  if (!policy.network) installFilter(Seccomp.network())
  restrictSelf(ruleset)
}

function readRules(denyRead: readonly string[]): Rule[] {
  const denied = new Set(denyRead)
  if (denied.size === 0) return [{ path: "/", access: read }]
  const ancestors = new Set(denyRead.flatMap(parents))
  const visit = (directory: string): Rule[] => [
    { path: directory, access: Access.readDir },
    ...entries(directory).flatMap((entry): Rule[] => {
      const full = path.join(directory, entry.name)
      if (denied.has(full)) return []
      if (ancestors.has(full)) return visit(full)
      const type = kind(entry, full)
      if (type === "link" || type === undefined) return []
      return [{ path: full, access: type === "directory" ? read : readFile }]
    }),
  ]
  return visit("/")
}

function writeRule(file: string): Rule[] {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat) return []
  return [{ path: file, access: stat.isDirectory() ? write : writeFile }]
}

function parents(file: string) {
  const result: string[] = []
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    result.push(current)
    if (current === path.dirname(current)) return result
  }
}

function kind(entry: fs.Dirent, full: string) {
  if (entry.isSymbolicLink()) return "link"
  if (entry.isDirectory()) return "directory"
  if (entry.isFile() || entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice())
    return "file"
  // The file system gave no type.
  const stat = fs.lstatSync(full, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (stat.isSymbolicLink()) return "link"
  return stat.isDirectory() ? "directory" : "file"
}
