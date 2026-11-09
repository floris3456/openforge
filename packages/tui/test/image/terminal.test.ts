import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { deflateSync } from "node:zlib"
import { imageID, passthrough, remove, transmit } from "../../src/image/placeholder"
import { createImageTerminal, DEFAULT_CELL, type ImageOutput } from "../../src/image/terminal"
import type { TmuxClient } from "../../src/tmux-terminal"

// openforge (spec image-view, Proof): inside tmux with a terminal that draws placeholders, images go through the
// renderer's ordered output, wrapped for tmux; they go again after a resize or a focus change, and are deleted when
// they go. Everywhere else nothing is sent.

const ghostty: TmuxClient = { termtype: "ghostty 1.4.0", passthrough: true, cell: { width: 19, height: 42 } }
const number = { index: 110, high: 3 }
const image = {
  pixels: { width: 2, height: 1, deflated: deflateSync(new Uint8Array(8).fill(200)) },
  columns: 1,
  rows: 1,
}

function fixture(input: { client?: TmuxClient; ansi256?: boolean; ask?: () => Promise<TmuxClient | undefined> } = {}) {
  const renderer = Object.assign(new EventEmitter(), {
    capabilities: { ansi256: input.ansi256 ?? true },
    resolution: null as { width: number; height: number } | null,
    terminalWidth: 100,
    terminalHeight: 30,
  })
  const written: string[] = []
  const output: ImageOutput = {
    write: (bytes) => {
      written.push(Buffer.from(bytes).toString("latin1"))
      return true
    },
    idle: async () => {},
  }
  const terminal = createImageTerminal({
    renderer,
    output,
    client: "client" in input ? input.client : ghostty,
    ask: input.ask,
    settleMs: 1,
  })
  // The settle delay, then every write it led to.
  const settle = async () => {
    await Bun.sleep(5)
    await terminal.drained()
  }
  return { renderer, written, terminal, output, settle }
}

const expected = (id: number) => transmit(id, image.pixels, image.columns, image.rows).map(passthrough)

describe("when images use placeholders", () => {
  test("inside tmux, with Ghostty 1.4 or kitty attached and passthrough on", () => {
    expect(fixture().terminal.placeholders).toBe(true)
    expect(fixture({ client: { ...ghostty, termtype: "kitty(0.36.4)" } }).terminal.placeholders).toBe(true)
    expect(fixture({ client: { ...ghostty, termtype: "ghostty 1.3.1" } }).terminal.placeholders).toBe(false)
    expect(fixture({ client: { ...ghostty, termtype: "WezTerm 20240203" } }).terminal.placeholders).toBe(false)
    expect(fixture({ client: { ...ghostty, passthrough: false } }).terminal.placeholders).toBe(false)
    expect(fixture({ client: undefined }).terminal.placeholders).toBe(false)
  })

  test("without placeholders nothing is sent", () => {
    const { terminal, written } = fixture({ client: undefined })
    terminal.show(number, image)
    terminal.hide(number)
    expect(written).toEqual([])
  })
})

describe("sending", () => {
  test("an image goes through tmux's passthrough, every chunk whole and in order, then its placement", async () => {
    const { terminal, written, settle } = fixture()
    terminal.show(number, image)
    await settle()
    expect(written).toEqual(expected(imageID(number, "index")))
  })

  test("written as 24 bits, it goes under both readings", async () => {
    const { terminal, written, settle } = fixture({ ansi256: false })
    terminal.show(number, image)
    await settle()
    expect(written).toEqual([...expected(imageID(number, "index")), ...expected(imageID(number, "rgb"))])
  })

  test("output under pressure is waited out, and the order kept", async () => {
    const { terminal, written, output, settle } = fixture()
    let refusals = 2
    let idles = 0
    const write = output.write
    Object.assign(output, {
      write: (bytes: Uint8Array) => (refusals-- > 0 ? false : write(bytes)),
      idle: async () => {
        idles++
      },
    })
    terminal.show(number, image)
    await settle()
    expect(idles).toBe(2)
    expect(written).toEqual(expected(imageID(number, "index")))
  })

  test("an image that goes is deleted from the terminal, and not sent again", async () => {
    const { terminal, written, renderer, settle } = fixture()
    terminal.show(number, image)
    terminal.hide(number)
    await settle()
    expect(written.slice(-1)).toEqual([passthrough(remove(imageID(number, "index")))])
    written.length = 0
    renderer.emit("resize", 120, 40)
    await settle()
    expect(written).toEqual([])
  })
})

describe("sending again", () => {
  test.each(["resize", "focus"])("after a %s every image goes again, once for a burst", async (event) => {
    const { terminal, written, renderer, settle } = fixture()
    terminal.show(number, image)
    const other = { index: 40, high: 9 }
    terminal.show(other, image)
    await settle()
    written.length = 0
    renderer.emit(event)
    renderer.emit(event)
    renderer.emit(event)
    await settle()
    expect(written).toEqual([...expected(imageID(number, "index")), ...expected(imageID(other, "index"))])
  })

  test("tmux is asked again; a new cell size refits the images instead", async () => {
    let asked = 0
    const { terminal, written, renderer, settle } = fixture({
      ask: async () => {
        asked++
        return { ...ghostty, cell: { width: 10, height: 21 } }
      },
    })
    terminal.show(number, image)
    await settle()
    written.length = 0
    expect(terminal.cell()).toEqual({ width: 19, height: 42 })
    renderer.emit("resize", 120, 40)
    await settle()
    expect(asked).toBe(1)
    expect(terminal.cell()).toEqual({ width: 10, height: 21 })
    // Each image's view fits it to the new cell and shows it; nothing old goes again.
    expect(written).toEqual([])
  })
})

describe("the cell size", () => {
  test("inside tmux, tmux's client's (or another client's), else 9×20, whatever pixel size tmux makes up", () => {
    expect(fixture().terminal.cell()).toEqual({ width: 19, height: 42 })
    const { renderer, terminal } = fixture({ client: { ...ghostty, cell: undefined } })
    renderer.resolution = { width: 1600, height: 960 }
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    expect(DEFAULT_CELL).toEqual({ width: 9, height: 20 })
  })

  test("outside tmux, the terminal's from its pixels, else 9×20", () => {
    const { renderer, terminal } = fixture({ client: undefined })
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    renderer.resolution = { width: 1000, height: 600 }
    expect(terminal.cell()).toEqual({ width: 10, height: 20 })
  })
})
