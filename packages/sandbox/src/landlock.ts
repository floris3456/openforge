export * as Landlock from "./landlock.js"

import fs from "node:fs"
import path from "node:path"
import { addPathRule, createRuleset, installFilter, landlock, restrictSelf } from "#native"
import { Seccomp } from "./seccomp.js"

// Landlock only grants. Every filesystem right the kernel knows is handled, so anything not granted is refused:
// reading is granted on everything except the denied paths, writing only beneath the write list.

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

/** The filesystem rights an ABI knows. ABI 9's right to connect to Unix sockets is left alone, so they keep working. */
export function handled(abi: number) {
  if (abi >= 5) return (1n << 16n) - 1n
  if (abi >= 3) return (1n << 15n) - 1n
  if (abi >= 2) return (1n << 14n) - 1n
  return (1n << 13n) - 1n
}

/** TCP bind and connect from ABI 4, UDP bind and send from ABI 10. */
export function network(abi: number) {
  if (abi >= 10) return 0xfn
  if (abi >= 4) return 0x3n
  return 0n
}

/** What `openforge sandbox-exec` receives: absolute, resolved paths. */
export interface Policy {
  readonly write: readonly string[]
  readonly deny: readonly string[]
  readonly network: boolean
}

export interface Rule {
  readonly path: string
  readonly access: bigint
}

export function encode(policy: Policy) {
  return Buffer.from(JSON.stringify({ v: 1, ...policy })).toString("base64url")
}

export function decode(text: string): Policy {
  const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString())
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== 1 ||
    !("write" in value) ||
    !paths(value.write) ||
    !("deny" in value) ||
    !paths(value.deny) ||
    !("network" in value) ||
    typeof value.network !== "boolean"
  )
    throw new Error("invalid sandbox policy")
  return { write: value.write, deny: value.deny, network: value.network }
}

function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && path.isAbsolute(item))
}

/**
 * The rules for a policy. Reading everything except the denied paths is built by granting, along the way from / to
 * each denied path, every sibling of that way; the folders on the way may only be listed. So a file created later in
 * one of those folders is readable only from the next command on.
 */
export function rules(policy: Policy): Rule[] {
  return [...readRules(policy.deny), ...policy.write.flatMap(writeRule)]
}

/**
 * Confines this thread for good: Landlock, plus seccomp when the network is off. Both pass to the program it then
 * execs and to that program's children. Returns the Landlock ABI used.
 */
export function confine(policy: Policy) {
  const abi = landlock()
  // ABI 1 refuses every rename or link between folders.
  if (abi < 2) throw new Error(abi === 0 ? "this kernel has no Landlock" : `Landlock ABI ${abi} is too old (needs 2)`)
  const fs = handled(abi)
  const ruleset = createRuleset(fs, policy.network ? 0n : network(abi))
  for (const rule of rules(policy)) addPathRule(ruleset, rule.path, rule.access & fs)
  if (!policy.network) installFilter(Seccomp.network())
  restrictSelf(ruleset)
  return abi
}

function readRules(deny: readonly string[]): Rule[] {
  const denied = new Set(deny)
  if (denied.size === 0) return [{ path: "/", access: read }]
  const ancestors = new Set(deny.flatMap(parents))
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

function entries(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
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
