import type { TmuxClient } from "./tmux-terminal"

// openforge (spec image-view): a TUI inside tmux that can't ask tmux (no TMUX: it came in by `docker exec`, or by ssh
// from a tmux pane) asks the terminal behind tmux itself, through tmux's passthrough: whether it draws Kitty graphics,
// its cell in pixels (CSI 16 t) and its name and version (XTVERSION). tmux hands the answers to the pane active in the
// client's window as typed keys, byte for byte: once tmux has the terminal's answer to its own XTVERSION, a later one
// isn't taken as tmux's (tmux 3.7c and 3.8, `tty_keys_extended_device_attributes` in tty-keys.c). Only a pane in
// modifyOtherKeys mode 2 gets them encoded as keys, and OpenTUI asks for mode 1. The answers are taken out of the input
// before OpenTUI sees them: a terminal's XTVERSION answer would make it think there is no tmux.
//
// Since the answers go to the active pane, a TUI asks only while its pane is that one. With tmux's focus-events it is
// told. Without them (the owner's tmux) it knows it at start, as the person just opened it, and again once a key or a
// paste comes, which tmux sends to the active pane only. A resize, as a client of another size attaching makes for
// every window of a session, doesn't say: it only marks the answer stale, and the next key or paste asks again. Mouse
// events don't count: tmux sends a wheel or a drag to the pane under the pointer without selecting it.

/** The Kitty graphics query's image id; the TUI's own images have a high byte, so never this one. */
const QUERY_ID = 7254017

/**
 * What is asked, in the order a terminal answers: whether it draws Kitty graphics, its cell, its name and version.
 * Every terminal answers XTVERSION, so its answer, coming last, ends the question.
 */
export const QUESTION = `\x1b_Gi=${QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[>q`

/** The longest a question waits for the answers. */
const LIMIT_MS = 1000

type Renderer = {
  on(event: "focus" | "blur" | "resize", listener: () => void): unknown
  off(event: "focus" | "blur" | "resize", listener: () => void): unknown
  prependInputHandler(handler: (sequence: string) => boolean): void
  removeInputHandler(handler: (sequence: string) => boolean): void
  readonly keyInput: {
    on(event: "keypress" | "paste", listener: () => void): unknown
    off(event: "keypress" | "paste", listener: () => void): unknown
  }
}

type Answer = { termtype?: string; graphics?: boolean; cell?: { readonly width: number; readonly height: number } }

export function createTmuxPassthrough(input: {
  readonly renderer: Renderer
  /** Sends a sequence to the terminal behind tmux, wrapped for tmux's passthrough, in order with the TUI's images. */
  readonly send: (sequence: string) => void
  /** Called when a key or a paste shows the pane active again after a resize made the answer stale. */
  readonly again: () => void
  readonly limitMs?: number
}) {
  /** Whether the pane is the active one, as tmux's focus events tell; undefined while none came. */
  let focused: boolean | undefined
  /** Without focus events: whether a resize came since the pane last showed it is the active one. */
  let stale = false
  let asking:
    | { readonly answer: Answer; readonly finish: () => void; readonly done: Promise<TmuxClient | undefined> }
    | undefined

  const onFocus = () => {
    focused = true
  }
  const onBlur = () => {
    focused = false
  }
  const onResize = () => {
    stale = true
  }
  const onInput = () => {
    if (focused !== undefined || !stale) return
    stale = false
    input.again()
  }
  const handler = (sequence: string) => {
    const reply = readReply(sequence)
    if (!reply) return false
    // A late answer, or one to another TUI's question in a pane that was active then, is dropped all the same.
    if (asking) Object.assign(asking.answer, reply)
    if (asking && reply.termtype !== undefined) asking.finish()
    return true
  }
  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)
  input.renderer.on("resize", onResize)
  input.renderer.keyInput.on("keypress", onInput)
  input.renderer.keyInput.on("paste", onInput)
  input.renderer.prependInputHandler(handler)

  return {
    /**
     * Asks the terminal behind tmux; nothing when no answer came, or while this pane may not be the active one, so
     * that the answers never land in another pane's input.
     */
    ask(): Promise<TmuxClient | undefined> {
      if (asking) return asking.done
      if (focused === false || (focused === undefined && stale)) return Promise.resolve(undefined)
      const answer: Answer = {}
      const { promise, resolve } = Promise.withResolvers<TmuxClient | undefined>()
      const timer = setTimeout(() => finish(), input.limitMs ?? LIMIT_MS)
      const finish = () => {
        clearTimeout(timer)
        asking = undefined
        resolve(clientOf(answer))
      }
      asking = { answer, finish, done: promise }
      input.send(QUESTION)
      return promise
    },
    dispose() {
      asking?.finish()
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
      input.renderer.off("resize", onResize)
      input.renderer.keyInput.off("keypress", onInput)
      input.renderer.keyInput.off("paste", onInput)
      input.renderer.removeInputHandler(handler)
    },
  }
}

/** An answer to the question, or undefined for any other input. */
export function readReply(sequence: string): Answer | undefined {
  const version = /^\x1bP>\|([^\x1b]*)\x1b\\$/.exec(sequence)
  // tmux itself answers OpenTUI's own XTVERSION; that answer stays OpenTUI's.
  if (version) return /^tmux\b/i.test(version[1]!) ? undefined : { termtype: version[1]!.trim() }
  const graphics = GRAPHICS.exec(sequence)
  if (graphics) return { graphics: graphics[1] === "OK" }
  const cell = /^\x1b\[6;(\d+);(\d+)t$/.exec(sequence)
  if (!cell) return
  const height = Number(cell[1])
  const width = Number(cell[2])
  return width > 0 && height > 0 ? { cell: { width, height } } : {}
}

const GRAPHICS = new RegExp(`^\\x1b_Gi=${QUERY_ID}(?:,[^;]*)?;([^\\x1b]*)\\x1b\\\\$`)

/** What the answers say, as tmux's answer would; nothing when none came, so what was known stays. */
function clientOf(answer: Answer): TmuxClient | undefined {
  if (answer.termtype === undefined && answer.graphics === undefined && answer.cell === undefined) return
  return {
    termtype: answer.termtype ?? "",
    passthrough: true,
    graphics: answer.graphics === true,
    ...(answer.cell && { cell: answer.cell }),
  }
}
