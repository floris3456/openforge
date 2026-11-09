import { execFile } from "node:child_process"
import type { Config } from "./config"

// openforge: behind tmux, OpenTUI's own detection sees tmux, which answers its terminal probes itself, so `auto` finds
// no notification sequence and no image protocol. tmux knows the terminal of each client attached to it
// (`#{client_termtype}`, from the terminal's answer to XTVERSION) and its cell size in pixels; the TUI asks it once
// for the client of its own pane's session when it starts. Notifications send that terminal's sequence, which OpenTUI
// then sends through tmux's passthrough, and images use its graphics (spec image-view).

type Protocol = Exclude<Config.Resolved["attention"]["protocol"], "auto">
type Environment = Readonly<Record<string, string | undefined>>
/** Runs tmux with these arguments; answers what it wrote, or nothing when it failed. */
type Ask = (args: readonly string[]) => Promise<string | undefined>

/** The longest the question may hold up the TUI's start. */
const LIMIT_MS = 300

/** What tmux says about the terminal attached to it. */
export type TmuxClient = {
  /** The terminal of the client attached to this pane's session, as it names itself; "" when tmux doesn't know. */
  readonly termtype: string
  /** Whether tmux passes this pane's sequences through to the terminal (`allow-passthrough` isn't `off`). */
  readonly passthrough: boolean
  /** That client's cell in pixels, or another client's of the same tmux when it doesn't know its own. */
  readonly cell?: { readonly width: number; readonly height: number }
}

/**
 * Asks tmux about the client attached to this pane's session, inside tmux only. `OPENFORGE_TEST_TERMINAL` names the
 * client's terminal instead, for live tests in a terminal that can't answer for itself; not a setting.
 */
export async function askTmux(
  env: Environment,
  ask?: Ask,
  options: { command?: readonly string[]; limitMs?: number } = {},
): Promise<TmuxClient | undefined> {
  if (!env.TMUX || !env.TMUX_PANE) return
  const answer = await (ask ?? run(options.command ?? ["tmux"], options.limitMs ?? LIMIT_MS))([
    "display-message",
    "-p",
    "-t",
    env.TMUX_PANE,
    "#{client_termtype}\t#{allow-passthrough}\t#{client_cell_width}\t#{client_cell_height}",
    ";",
    "list-clients",
    "-F",
    "\t\t#{client_cell_width}\t#{client_cell_height}",
  ])
  if (answer === undefined) return
  const lines = answer.split("\n").filter((line) => line.includes("\t"))
  const [termtype = "", passthrough = ""] = (lines[0] ?? "").split("\t")
  const cell = lines.map(cellOf).find((found) => found !== undefined)
  return {
    termtype: env.OPENFORGE_TEST_TERMINAL ?? termtype.trim(),
    passthrough: passthrough.trim() !== "off",
    ...(cell && { cell }),
  }
}

/** The renderer's environment for a notification protocol: the one set, or behind tmux the attached terminal's. */
export function notificationEnvironment(
  protocol: Config.Resolved["attention"]["protocol"],
  env: Environment,
  client: TmuxClient | undefined,
) {
  if (protocol !== "auto") return { OPENTUI_NOTIFICATION_PROTOCOL: protocol }
  if (env.OPENTUI_NOTIFICATION_PROTOCOL !== undefined) return
  const found = protocolFor(client?.termtype ?? "")
  if (found) return { OPENTUI_NOTIFICATION_PROTOCOL: found }
}

/** The sequence a terminal shows, by the name it gives: OpenTUI's lists, with Konsole added to OSC 777's. */
export function protocolFor(termtype: string): Protocol | undefined {
  const name = termtype.toLowerCase()
  const has = (names: readonly string[]) => names.some((item) => name.includes(item.toLowerCase()))
  if (has(["kitty", "foot"])) return "osc99"
  if (has(OSC777)) return "osc777"
  if (has(["iterm", "Apple_Terminal", "Terminal.app"])) return "osc9"
}

/**
 * Whether a terminal draws Kitty graphics through Unicode placeholders, by the name it gives: kitty from 0.28, and
 * Ghostty from 1.4 (1.3 draws them too narrow inside tmux, Ghostty issue 13056, and has a Kitty graphics advisory,
 * GHSA-mhff-mv4q-fp63).
 */
export function showsPlaceholders(termtype: string) {
  const found = /(kitty|ghostty)\D*(\d+)\.(\d+)/i.exec(termtype)
  if (!found) return false
  const version = Number(found[2]) * 1000 + Number(found[3])
  return found[1]!.toLowerCase() === "kitty" ? version >= 28 : version >= 1004
}

const OSC777 = [
  "ghostty",
  "konsole",
  "wezterm",
  "warp",
  "hterm",
  "blink",
  "contour",
  "vte",
  "gnome",
  "tilix",
  "terminator",
  "xfce",
  "urxvt",
  "rxvt",
  "windows terminal",
  "windows_terminal",
  "terminology",
]

function cellOf(line: string) {
  const [, , width, height] = line.split("\t").map((value) => Number(value.trim()))
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return
  return { width, height }
}

function run(command: readonly string[], limitMs: number): Ask {
  return (args) =>
    new Promise((resolve) =>
      execFile(command[0]!, [...command.slice(1), ...args], { timeout: limitMs, encoding: "utf8" }, (error, stdout) =>
        resolve(error ? undefined : stdout),
      ),
    )
}
