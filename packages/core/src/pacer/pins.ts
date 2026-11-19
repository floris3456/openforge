export * as PacerPins from "./pins.js"

import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import type { CodeModePins } from "../codemode/pins.js"

// The Code Mode pins a chat's agent sets itself, told to CLIProxyPacer on each read of the chat's tool list
// (`X-Pacer-Pins`; CPP's API.md, "Web tools", below the table, and CLIENT-GUIDE.md 4.3, "Saying who reads"). CPP only
// records them for its Agents card ("pinned in .opencode/agent/build.md"): the list is the same with them or without
// them, and no model request carries them, so they cost no chat its prompt cache.

export const HEADER = "X-Pacer-Pins"
/**
 * CPP's limits: it ignores a header of more than `BYTES`, keeps `TOOLS` of its tools and drops a tool whose `from` has
 * more than `FROM` characters. The value is cut to them here, so CPP keeps what it is sent.
 */
export const BYTES = 4096
export const TOOLS = 32
export const FROM = 300

/** The pins as CPP is told them, by tool, each `from` as {@link of} writes it. */
export type Pins = Readonly<Record<string, CodeModePins.Sourced>>

/**
 * A session's pins ({@link CodeModePins.sourced}) with each file as the Agents card shows it: relative to the chat's
 * project when the file is in it (`.opencode/agent/build.md`, `opencode.json`), else with the home folder as `~`.
 */
export function of(
  pins: Readonly<Record<string, CodeModePins.Sourced>>,
  places: { readonly project: string; readonly home: string },
): Pins {
  return Object.fromEntries(
    Object.entries(pins).map(([tool, pin]) => [
      tool,
      pin.from === undefined ? pin : { pinned: pin.pinned, from: place(pin.from, places) },
    ]),
  )
}

/**
 * The header's value, `encodeURIComponent(JSON.stringify(pins))`, the tools in name order as CPP keeps them, within
 * CPP's limits: a longer `from` loses its start, and the tools past `TOOLS` or `BYTES` are left out. `cut` says whether
 * anything was. None without pins.
 */
export function header(pins: Pins): { readonly value?: string; readonly cut: boolean } {
  const sorted = Object.entries(pins)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([tool, pin]) => [tool, shorten(pin)] as const)
  const kept =
    Array.from({ length: Math.min(sorted.length, TOOLS) + 1 }, (_, count) => count).findLast(
      (count) => encode(sorted.slice(0, count)).length <= BYTES,
    ) ?? 0
  const cut = kept < sorted.length || sorted.some(([tool, pin]) => pin.from !== pins[tool]?.from)
  return kept === 0 ? { cut } : { value: encode(sorted.slice(0, kept)), cut }
}

function encode(pins: ReadonlyArray<readonly [string, CodeModePins.Sourced]>) {
  return encodeURIComponent(JSON.stringify(Object.fromEntries(pins)))
}

/** A `from` of more than `FROM` characters as its last ones, after an ellipsis: the file's name is what tells. */
function shorten(pin: CodeModePins.Sourced): CodeModePins.Sourced {
  const letters = pin.from === undefined ? [] : [...pin.from]
  if (letters.length <= FROM) return pin
  return { pinned: pin.pinned, from: `…${letters.slice(-(FROM - 1)).join("")}` }
}

function place(file: string, places: { readonly project: string; readonly home: string }) {
  const slashed = (value: string) => value.split(path.sep).join("/")
  if (FSUtil.contains(places.project, file) && file !== places.project)
    return slashed(path.relative(places.project, file))
  if (FSUtil.contains(places.home, file) && file !== places.home)
    return `~/${slashed(path.relative(places.home, file))}`
  return slashed(file)
}
