/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { EventEmitter } from "node:events"
import { inflateSync } from "node:zlib"
import type { JSX } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DIACRITICS } from "../../src/image/placeholder"
import { createImageTerminal, ImageTerminalProvider, type Cell } from "../../src/image/terminal"
import type { TmuxClient } from "../../src/tmux-terminal"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "./fixture"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"

/**
 * An image terminal as inside tmux with Ghostty 1.4 attached (`placeholders`), or as outside it; what it sends is
 * kept in `sent`, as the sequences tmux's passthrough carries.
 */
export function imageTerminal(input: {
  placeholders: boolean
  cell?: Cell
  /** tmux's client when the TUI starts, instead of Ghostty 1.4 or none; and its answer when asked again. */
  client?: TmuxClient
  ask?: () => Promise<TmuxClient | undefined>
}) {
  const renderer = Object.assign(new EventEmitter(), {
    capabilities: { ansi256: true },
    resolution: null,
    terminalWidth: 100,
    terminalHeight: 30,
  })
  const client: TmuxClient | undefined =
    input.client ??
    (input.placeholders
      ? { termtype: "ghostty 1.4.0", passthrough: true, cell: input.cell ?? { width: 9, height: 20 } }
      : undefined)
  const sent: string[] = []
  const terminal = createImageTerminal({
    renderer,
    client,
    ask: input.ask,
    settleMs: 1,
    output: {
      write: (bytes) => {
        sent.push(unwrap(Buffer.from(bytes).toString("latin1")))
        return true
      },
      idle: async () => {},
    },
  })
  return { terminal, sent, renderer }
}

/** The graphics commands sent, without their payload: `{ keys: "a=t,…", data: "…" }`. */
export function commands(sent: readonly string[]) {
  return sent.map((sequence) => {
    const found = /^\x1b_G([^;]*)(?:;(.*))?\x1b\\$/s.exec(sequence)
    if (!found) throw new Error(`not a graphics command: ${JSON.stringify(sequence.slice(0, 40))}`)
    return { keys: found[1]!, data: found[2] ?? "" }
  })
}

/** Every image transmitted: its keys and its RGBA pixels. */
export function transmitted(sent: readonly string[]) {
  const all = commands(sent)
  return all.flatMap((command, index) => {
    if (!command.keys.startsWith("a=t,")) return []
    const rest = all.slice(index)
    const end = rest.findIndex((item) => /(^|,)m=0(,|$)/.test(item.keys))
    const data = rest
      .slice(0, end + 1)
      .map((item) => item.data)
      .join("")
    const keys = Object.fromEntries(command.keys.split(",").map((pair) => pair.split("=") as [string, string]))
    return [{ keys, rgba: inflateSync(Buffer.from(data, "base64")) }]
  })
}

/** The UI around a component, with an image terminal. */
export function renderWithImages(
  component: () => JSX.Element,
  terminal: ReturnType<typeof imageTerminal>["terminal"],
  options: { width: number; height: number } = { width: 80, height: 24 },
) {
  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <ImageTerminalProvider value={terminal}>
                  <DialogProvider>{component()}</DialogProvider>
                </ImageTerminalProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { ...options, kittyKeyboard: true },
  )
}

/** Renders until `predicate` holds, for at most two seconds: images decode and deflate off the frame. */
export async function until(
  app: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  predicate: () => boolean,
) {
  const deadline = Date.now() + 2_000
  while (true) {
    await app.renderOnce()
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for the image; the frame:\n${app.captureCharFrame()}`)
    await Bun.sleep(5)
  }
}

/** The placeholder cells of the frame, each as [row, column] of its image, by screen row. */
export function placeholderCells(frame: string) {
  return frame
    .split("\n")
    .map((line) =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)]
        .map((part) => [...part.segment].map((char) => char.codePointAt(0)!))
        .filter((points) => points[0] === 0x10eeee)
        .map((points) => [DIACRITIC_VALUES.get(points[1]!)!, DIACRITIC_VALUES.get(points[2]!)!] as const),
    )
    .filter((line) => line.length > 0)
}

// The placeholder module's own table (its first and last values are checked against kitty's in placeholder.test).
const DIACRITIC_VALUES = new Map(DIACRITICS.map((point, value) => [point, value]))

function unwrap(sequence: string) {
  const found = /^\x1bPtmux;(.*)\x1b\\$/s.exec(sequence)
  if (!found) throw new Error("not wrapped for tmux's passthrough")
  return found[1]!.replaceAll("\x1b\x1b", "\x1b")
}
