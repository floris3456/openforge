export * as ConfigSandbox from "./sandbox.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Mode = Schema.Literals(["write", "read", "off"]).annotate({ identifier: "Config.Sandbox.Mode" })
export type Mode = typeof Mode.Type

/** The permission a shell command needs to run outside the sandbox (`sandbox: false`). */
export const permission = "unsandboxed"

export const Info = Schema.Struct({
  mode: Mode.pipe(optional).annotate({
    description:
      'How shell commands are sandboxed: "write" (default) lets them write only to the chat\'s folder, its git folders, the temp folder and the package caches; "read" only to the temp folder; "off" runs them unsandboxed',
  }),
  network: Schema.Boolean.pipe(optional).annotate({
    description: "Whether sandboxed commands may use the IPv4 and IPv6 network (default: true)",
  }),
  write: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "More paths sandboxed commands may write to in write mode; ~ is the home folder, relative paths start at the chat's folder",
  }),
  deny_read: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "More paths sandboxed commands may not read; ~ is the home folder, relative paths start at the chat's folder",
  }),
  required: Schema.Boolean.pipe(optional).annotate({
    description: "Refuse commands when this machine cannot sandbox them, instead of running them unsandboxed",
  }),
}).annotate({ identifier: "Config.Sandbox" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
/** A merge's result, with arrays of its own, so it can go into a mutable draft (an agent being edited). */
export interface Merged {
  mode?: Mode
  network?: boolean
  write?: string[]
  deny_read?: string[]
  required?: boolean
}

/** Layers settings from lowest to highest priority: the last mode, network and required set win; paths add up. */
export function merge(...layers: ReadonlyArray<Info | undefined>): Merged | undefined {
  const present = layers.filter((layer): layer is Info => layer !== undefined)
  if (present.length === 0) return undefined
  const mode = present.findLast((layer) => layer.mode !== undefined)?.mode
  const network = present.findLast((layer) => layer.network !== undefined)?.network
  const required = present.findLast((layer) => layer.required !== undefined)?.required
  const write = present.flatMap((layer) => layer.write ?? [])
  const deny = present.flatMap((layer) => layer.deny_read ?? [])
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(network === undefined ? {} : { network }),
    ...(write.length === 0 ? {} : { write }),
    ...(deny.length === 0 ? {} : { deny_read: deny }),
    ...(required === undefined ? {} : { required }),
  }
}
