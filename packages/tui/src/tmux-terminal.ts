import { execFile } from "node:child_process"
import type { Config } from "./config"

// openforge: behind tmux, OpenTUI's own detection sees tmux, which answers its terminal probes itself, so `auto` finds
// no notification sequence. tmux knows the terminal of each client attached to it (`#{client_termtype}`, from the
// terminal's answer to XTVERSION); the TUI asks it for the client of its own pane's session when it starts, and sets
// that terminal's sequence, which OpenTUI then sends through tmux's passthrough.

type Protocol = Exclude<Config.Resolved["attention"]["protocol"], "auto">
type Environment = Readonly<Record<string, string | undefined>>
/** Runs tmux with these arguments; answers what it wrote, or nothing when it failed. */
type Ask = (args: readonly string[]) => Promise<string | undefined>

/** The longest the question may hold up the TUI's start. */
const LIMIT_MS = 300

/** The renderer's environment for a notification protocol: the one set, or behind tmux the attached terminal's. */
export async function notificationEnvironment(
  protocol: Config.Resolved["attention"]["protocol"],
  env: Environment,
  ask?: Ask,
  options: { command?: readonly string[]; limitMs?: number } = {},
) {
  if (protocol !== "auto") return { OPENTUI_NOTIFICATION_PROTOCOL: protocol }
  if (!env.TMUX || !env.TMUX_PANE || env.OPENTUI_NOTIFICATION_PROTOCOL !== undefined) return
  const answer = await (ask ?? run(options.command ?? ["tmux"], options.limitMs ?? LIMIT_MS))([
    "display-message",
    "-p",
    "-t",
    env.TMUX_PANE,
    "#{client_termtype}",
  ])
  const found = protocolFor(answer?.trim() ?? "")
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

function run(command: readonly string[], limitMs: number): Ask {
  return (args) =>
    new Promise((resolve) =>
      execFile(command[0]!, [...command.slice(1), ...args], { timeout: limitMs, encoding: "utf8" }, (error, stdout) =>
        resolve(error ? undefined : stdout),
      ),
    )
}
