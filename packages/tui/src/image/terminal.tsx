import type { CliRenderer } from "@opentui/core"
import { batch, createContext, createSignal, useContext, type ParentProps } from "solid-js"
import { showsPlaceholders, type TmuxClient } from "../tmux-terminal"
import { imageIDs, passthrough, remove, transmit, type ImageNumber, type Pixels } from "./placeholder"

// openforge (spec image-view): where the TUI's images go. Inside tmux, when the terminal attached to it draws Kitty
// graphics through Unicode placeholders, images go to it through the renderer's own ordered output, so a frame is never
// cut by them, and again whenever the terminal may have lost them: a resize (a client of another size attached) and a
// focus change (a client attached, or the window or pane switched back). Then tmux is asked again, so the images follow
// the client attached now: its terminal and its cell size. Everywhere else OpenTUI draws images itself.

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

/** What of the renderer the image terminal reads: its resize and focus events, its colours and its pixel size. */
type Renderer = {
  on(event: "resize" | "focus", listener: () => void): unknown
  off(event: "resize" | "focus", listener: () => void): unknown
  readonly capabilities: Pick<NonNullable<CliRenderer["capabilities"]>, "ansi256"> | null
  readonly resolution: { readonly width: number; readonly height: number } | null
  readonly terminalWidth: number
  readonly terminalHeight: number
}

export function createImageTerminal(input: {
  readonly renderer: Renderer
  readonly output?: ImageOutput
  /** What tmux said about its client when the TUI started; undefined outside tmux. */
  readonly client?: TmuxClient
  /** Asks tmux again, when the terminal may have changed. */
  readonly ask?: () => Promise<TmuxClient | undefined>
  /** How long after a resize or focus change the images go again; tests shorten it. */
  readonly settleMs?: number
}): ImageTerminal & { readonly drained: () => Promise<void>; readonly dispose: () => void } {
  const output = input.output
  const [client, setClient] = createSignal(input.client)
  const [version, setVersion] = createSignal(0)
  const shown = new Map<string, { readonly number: ImageNumber; readonly image: Shown; readonly ids: number[] }>()
  let queue = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let again: Promise<void> = Promise.resolve()

  const placeholders = () => {
    const current = client()
    return Boolean(output && current?.passthrough && showsPlaceholders(current.termtype))
  }

  const cell = () => {
    version()
    const known = client()?.cell
    if (known) return known
    // Inside tmux the terminal's pixel size is tmux's answer, which is made up (16×32 a cell) for a client that doesn't
    // tell it its own, as one that came in by `docker exec` doesn't; another client's, asked above, or 9×20 then.
    if (input.client) return DEFAULT_CELL
    const resolution = input.renderer.resolution
    const columns = input.renderer.terminalWidth
    const rows = input.renderer.terminalHeight
    if (resolution && resolution.width > 0 && resolution.height > 0 && columns > 0 && rows > 0)
      return { width: resolution.width / columns, height: resolution.height / rows }
    return DEFAULT_CELL
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
    const next = input.ask ? await input.ask() : undefined
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

  // Inside tmux only, where the client attached may change.
  if (input.client && output) {
    input.renderer.on("resize", changed)
    input.renderer.on("focus", changed)
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
