import type { CliRenderer } from "@opentui/core"
import { batch, createContext, createSignal, useContext, type ParentProps } from "solid-js"
import { createTmuxPassthrough } from "../tmux-passthrough"
import { showsPlaceholders, type TmuxClient } from "../tmux-terminal"
import { imageIDs, passthrough, remove, transmit, type ImageNumber, type Pixels } from "./placeholder"

// openforge (spec image-view): where the TUI's images go. Inside tmux, when the terminal attached to it draws Kitty
// graphics through Unicode placeholders, images go to it through the renderer's own ordered output, so a frame is never
// cut by them, and again whenever the terminal may have lost them: a resize (a client of another size attached) and a
// focus change (a client attached, or the window or pane switched back). Then tmux is asked again, so the images follow
// the client attached now: its terminal and its cell size. A TUI that can't ask tmux (no TMUX, as through `docker exec`
// or ssh from a tmux pane) asks the terminal behind it instead, through tmux's passthrough (../tmux-passthrough), at
// once and then on the same events. Everywhere else OpenTUI draws images itself.

export type Cell = { readonly width: number; readonly height: number }

/** An image as the terminal gets it: its pixels and the placement of `columns` × `rows` cells they are fitted to. */
export type Shown = { readonly pixels: Pixels; readonly columns: number; readonly rows: number }

export type ImageTerminal = {
  /** Whether images are drawn with placeholders, now; otherwise OpenTUI draws them its own way. */
  readonly placeholders: boolean
  /** The terminal's cell in pixels. */
  readonly cell: () => Cell
  /** Puts an image in the terminal under `number`, replacing what it had there, and again after a resize or focus. */
  readonly show: (number: ImageNumber, image: Shown) => void
  /** Takes the image under `number` out of the terminal. */
  readonly hide: (number: ImageNumber) => void
}

/** The renderer's ordered output: `write` copies all bytes or refuses them under pressure; `idle` waits it out. */
export type ImageOutput = { readonly write: (bytes: Uint8Array) => boolean; readonly idle: () => Promise<void> }

/** The cell size when neither tmux nor the terminal tells it. */
export const DEFAULT_CELL: Cell = { width: 9, height: 20 }

/** How long after a resize or focus change the images go again, so a burst of them sends once. */
const SETTLE_MS = 50

/** The cell tmux gives a window none of whose clients told it theirs (`DEFAULT_XPIXEL`, `DEFAULT_YPIXEL`). */
const MADE_UP_CELL: Cell = { width: 16, height: 32 }

type Event = "resize" | "focus" | "blur" | "capabilities"

/**
 * What of the renderer the image terminal reads: its resize, focus and capability events, its colours, whether it
 * runs inside tmux, its pixel size, and its input, where answers through tmux's passthrough come back and keys show
 * that its pane is the active one.
 */
type Renderer = {
  on(event: Event, listener: () => void): unknown
  off(event: Event, listener: () => void): unknown
  readonly capabilities: Pick<NonNullable<CliRenderer["capabilities"]>, "ansi256" | "multiplexer"> | null
  readonly resolution: { readonly width: number; readonly height: number } | null
  readonly terminalWidth: number
  readonly terminalHeight: number
  prependInputHandler(handler: (sequence: string) => boolean): void
  removeInputHandler(handler: (sequence: string) => boolean): void
  readonly keyInput: {
    on(event: "keypress" | "paste", listener: () => void): unknown
    off(event: "keypress" | "paste", listener: () => void): unknown
  }
}

export function createImageTerminal(input: {
  readonly renderer: Renderer
  readonly output?: ImageOutput
  /** What tmux said about its client when the TUI started; undefined outside tmux, or when tmux couldn't be asked. */
  readonly client?: TmuxClient
  /** Asks tmux again, when the terminal may have changed. */
  readonly ask?: () => Promise<TmuxClient | undefined>
  /** How long after a resize or focus change the images go again; tests shorten it. */
  readonly settleMs?: number
  /** How long a question through tmux's passthrough waits for its answers; tests shorten it. */
  readonly passthroughMs?: number
}): ImageTerminal & { readonly drained: () => Promise<void>; readonly dispose: () => void } {
  const output = input.output
  const [client, setClient] = createSignal(input.client)
  const [version, setVersion] = createSignal(0)
  const shown = new Map<string, { readonly number: ImageNumber; readonly image: Shown; readonly ids: number[] }>()
  let queue = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let again: Promise<void> = Promise.resolve()
  let through: ReturnType<typeof createTmuxPassthrough> | undefined

  const placeholders = () => {
    const current = client()
    return Boolean(output && current?.passthrough && current.graphics !== false && showsPlaceholders(current.termtype))
  }

  const cell = () => {
    version()
    const known = client()?.cell
    if (known) return known
    const resolution = input.renderer.resolution
    const columns = input.renderer.terminalWidth
    const rows = input.renderer.terminalHeight
    if (!resolution || resolution.width <= 0 || resolution.height <= 0 || columns <= 0 || rows <= 0) return DEFAULT_CELL
    const found = { width: resolution.width / columns, height: resolution.height / rows }
    // Inside tmux the terminal's pixel size is tmux's answer: real once a client told tmux its cell (tmux 3.6 and later
    // ask a terminal whose pty doesn't say), made up for a window whose clients didn't, as ones that came in by
    // `docker exec` to an older tmux.
    const inside = input.client !== undefined || through !== undefined
    if (inside && found.width === MADE_UP_CELL.width && found.height === MADE_UP_CELL.height) return DEFAULT_CELL
    return found
  }

  const send = (sequences: readonly string[]) => {
    if (!output) return
    const bytes = sequences.map((sequence) => Buffer.from(passthrough(sequence), "latin1"))
    queue = queue.then(() => writeAll(output, bytes)).catch(() => {})
  }

  const show = (number: ImageNumber, image: Shown) => {
    if (!placeholders()) return
    const ids = imageIDs(number, input.renderer.capabilities?.ansi256 === true)
    shown.set(key(number), { number, image, ids })
    send(ids.flatMap((id) => transmit(id, image.pixels, image.columns, image.rows)))
  }

  const hide = (number: ImageNumber) => {
    const entry = shown.get(key(number))
    if (!entry) return
    shown.delete(key(number))
    send(entry.ids.map(remove))
  }

  const resend = async () => {
    const next = await (through ? through.ask() : input.ask?.())
    const before = { placeholders: placeholders(), cell: cell() }
    batch(() => {
      if (next) setClient(next)
      setVersion((value) => value + 1)
    })
    // Another terminal or cell size: each image's view draws it the new way, or fits it again, and shows it itself.
    const after = cell()
    if (placeholders() !== before.placeholders) return
    if (after.width !== before.cell.width || after.height !== before.cell.height) return
    shown.forEach((entry) => show(entry.number, entry.image))
  }

  const changed = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      again = resend()
    }, input.settleMs ?? SETTLE_MS)
  }

  const watch = () => {
    input.renderer.on("resize", changed)
    input.renderer.on("focus", changed)
  }

  // Without tmux's answer, once OpenTUI knows it runs inside tmux (from TERM, or from tmux's own answer to XTVERSION,
  // which can come after the start), the terminal behind tmux is asked through the passthrough, at once.
  const enter = () => {
    if (through || input.renderer.capabilities?.multiplexer !== "tmux") return
    input.renderer.off("capabilities", enter)
    through = createTmuxPassthrough({
      renderer: input.renderer,
      send: (sequence) => send([sequence]),
      again: changed,
      limitMs: input.passthroughMs,
    })
    watch()
    again = resend()
  }

  // Inside tmux only, where the client attached may change.
  if (input.client && output) watch()
  if (!input.client && output) {
    input.renderer.on("capabilities", enter)
    enter()
  }

  return {
    get placeholders() {
      return placeholders()
    },
    cell,
    show,
    hide,
    /** Resolves once a pending re-send and every write so far went out. */
    drained: () => again.then(() => queue),
    dispose: () => {
      if (timer) clearTimeout(timer)
      through?.dispose()
      input.renderer.off("capabilities", enter)
      input.renderer.off("resize", changed)
      input.renderer.off("focus", changed)
    },
  }
}

const context = createContext<ImageTerminal>()

export function ImageTerminalProvider(props: ParentProps<{ value: ImageTerminal }>) {
  return <context.Provider value={props.value}>{props.children}</context.Provider>
}

/** The TUI's image terminal; without one, OpenTUI draws every image. */
export function useImageTerminal(): ImageTerminal {
  return useContext(context) ?? FALLBACK
}

const FALLBACK: ImageTerminal = {
  placeholders: false,
  cell: () => DEFAULT_CELL,
  show: () => {},
  hide: () => {},
}

function key(number: ImageNumber) {
  return `${number.high}:${number.index}`
}

/** Writes each sequence whole and in order, waiting while the renderer's output is full. */
async function writeAll(output: ImageOutput, bytes: readonly Uint8Array[]) {
  for (const chunk of bytes) {
    // Output that stays refused after it went idle (a suspended or closing terminal) drops the image.
    for (let attempt = 0; !output.write(chunk); attempt++) {
      if (attempt === RETRIES) return
      await output.idle()
    }
  }
}

const RETRIES = 50
