import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { deflateSync } from "node:zlib"
import { imageID, passthrough, remove, transmit } from "../../src/image/placeholder"
import { createImageTerminal, DEFAULT_CELL, type ImageOutput } from "../../src/image/terminal"
import { QUESTION } from "../../src/tmux-passthrough"
import type { TmuxClient } from "../../src/tmux-terminal"

// openforge (spec image-view, Proof): inside tmux with a terminal that draws placeholders, images go through the
// renderer's ordered output, wrapped for tmux; they go again after a resize or a focus change, and are deleted when
// they go. A TUI that can't ask tmux asks the terminal behind it through the passthrough. Everywhere else nothing is
// sent.

const ghostty: TmuxClient = { termtype: "ghostty 1.4.0", passthrough: true, cell: { width: 19, height: 42 } }
const number = { index: 110, high: 3 }
const image = {
  pixels: { width: 2, height: 1, deflated: deflateSync(new Uint8Array(8).fill(200)) },
  columns: 1,
  rows: 1,
}

function fixture(
  input: {
    client?: TmuxClient
    ansi256?: boolean
    ask?: () => Promise<TmuxClient | undefined>
    /** Whether OpenTUI knows it runs inside tmux; so whenever tmux's client is given. */
    multiplexer?: "tmux" | "none"
    passthroughMs?: number
  } = {},
) {
  const client = "client" in input ? input.client : ghostty
  const handlers: ((sequence: string) => boolean)[] = []
  const renderer = Object.assign(new EventEmitter(), {
    capabilities: {
      ansi256: input.ansi256 ?? true,
      multiplexer: input.multiplexer ?? (client ? "tmux" : "none"),
    },
    resolution: null as { width: number; height: number } | null,
    terminalWidth: 100,
    terminalHeight: 30,
    prependInputHandler: (handler: (sequence: string) => boolean) => handlers.unshift(handler),
    removeInputHandler: (handler: (sequence: string) => boolean) => handlers.splice(handlers.indexOf(handler), 1),
    keyInput: new EventEmitter(),
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
    client,
    ask: input.ask,
    settleMs: 1,
    passthroughMs: input.passthroughMs ?? 60_000,
  })
  // The settle delay, then every write it led to.
  const settle = async () => {
    await Bun.sleep(5)
    await terminal.drained()
  }
  /** Input coming back from the terminal, as OpenTUI hands it to its handlers. */
  const answer = (sequences: readonly string[]) => sequences.forEach((sequence) => handlers.some((h) => h(sequence)))
  return { renderer, written, terminal, output, settle, answer }
}

/** The answers of Ghostty 1.4 with 19×42 cells, as tmux hands them to the pane. */
const GHOSTTY = ["\x1b_Gi=7254017;OK\x1b\\", "\x1b[6;42;19t", "\x1bP>|ghostty 1.4.0-arch1.1\x1b\\"]
/** Another client's: Ghostty 1.4 with 18×37 cells. */
const MAC = ["\x1b_Gi=7254017;OK\x1b\\", "\x1b[6;37;18t", "\x1bP>|ghostty 1.4.0\x1b\\"]

/** Waits for the question, which goes once the settle delay is over; the answers come after it. */
async function asked(written: readonly string[]) {
  const deadline = Date.now() + 2_000
  while (written.length === 0 && Date.now() < deadline) await Bun.sleep(1)
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

describe("the client attached now", () => {
  test("a TUI started before a client attached draws placeholders once one that shows them attaches", async () => {
    const { terminal, renderer, settle } = fixture({
      client: { termtype: "", passthrough: true },
      ask: async () => ghostty,
    })
    expect(terminal.placeholders).toBe(false)
    renderer.emit("resize", 140, 47)
    await settle()
    expect(terminal.placeholders).toBe(true)
    expect(terminal.cell()).toEqual({ width: 19, height: 42 })
  })

  test("a client whose terminal can't show them turns them off, and nothing old is sent again", async () => {
    const { terminal, renderer, settle, written } = fixture({
      ask: async () => ({ termtype: "WezTerm 20240203", passthrough: true }),
    })
    terminal.show(number, image)
    await settle()
    written.length = 0
    renderer.emit("focus")
    await settle()
    expect(terminal.placeholders).toBe(false)
    expect(written).toEqual([])
  })

  test("outside tmux nothing is asked", () => {
    const { renderer } = fixture({ client: undefined })
    expect(renderer.listenerCount("resize")).toBe(0)
    expect(renderer.listenerCount("focus")).toBe(0)
  })
})

describe("the cell size", () => {
  test("inside tmux, tmux's client's (or another client's), else the renderer's unless tmux made it up, else 9×20", () => {
    expect(fixture().terminal.cell()).toEqual({ width: 19, height: 42 })
    const { renderer, terminal } = fixture({ client: { ...ghostty, cell: undefined } })
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    // 16×32 a cell is what tmux answers for a window none of whose clients told it their cell.
    renderer.resolution = { width: 1600, height: 960 }
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    renderer.resolution = { width: 1900, height: 1260 }
    expect(terminal.cell()).toEqual({ width: 19, height: 42 })
    expect(DEFAULT_CELL).toEqual({ width: 9, height: 20 })
  })

  test("outside tmux, the terminal's from its pixels, else 9×20", () => {
    const { renderer, terminal } = fixture({ client: undefined })
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    renderer.resolution = { width: 1000, height: 600 }
    expect(terminal.cell()).toEqual({ width: 10, height: 20 })
  })
})

describe("a TUI that can't ask tmux (no TMUX, as through docker exec)", () => {
  const behind = { client: undefined, multiplexer: "tmux" } as const

  test("asks the terminal behind tmux at once, and with Ghostty 1.4's answers draws placeholders at its cell", async () => {
    const { terminal, written, answer, settle } = fixture(behind)
    expect(terminal.placeholders).toBe(false)
    answer(GHOSTTY)
    await terminal.drained()
    expect(written).toEqual([passthrough(QUESTION)])
    expect(terminal.placeholders).toBe(true)
    expect(terminal.cell()).toEqual({ width: 19, height: 42 })
    written.length = 0
    terminal.show(number, image)
    await settle()
    expect(written).toEqual(expected(imageID(number, "index")))
  })

  test("a terminal that doesn't answer keeps the blocks, its cell the renderer's unless tmux made it up", async () => {
    const { terminal, renderer, written } = fixture({ ...behind, passthroughMs: 1 })
    await terminal.drained()
    expect(written).toEqual([passthrough(QUESTION)])
    expect(terminal.placeholders).toBe(false)
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    renderer.resolution = { width: 1600, height: 960 }
    expect(terminal.cell()).toEqual(DEFAULT_CELL)
    renderer.resolution = { width: 1900, height: 1260 }
    expect(terminal.cell()).toEqual({ width: 19, height: 42 })
  })

  test.each([
    ["Ghostty 1.3", ["\x1b_Gi=7254017;OK\x1b\\", "\x1bP>|ghostty 1.3.1\x1b\\"]],
    ["a refused Kitty query", ["\x1b_Gi=7254017;ENOTSUPPORTED:off\x1b\\", "\x1bP>|ghostty 1.4.0\x1b\\"]],
    ["no Kitty answer", ["\x1bP>|kitty(0.36.4)\x1b\\"]],
    ["WezTerm", ["\x1b_Gi=7254017;OK\x1b\\", "\x1bP>|WezTerm 20240203-110809-5046fc22\x1b\\"]],
  ])("%s keeps the blocks", async (_, answers) => {
    const { terminal, answer } = fixture(behind)
    answer(answers)
    await terminal.drained()
    expect(terminal.placeholders).toBe(false)
  })

  test("kitty 0.28 or later draws placeholders too", async () => {
    const { terminal, answer } = fixture(behind)
    answer(["\x1b_Gi=7254017;OK\x1b\\", "\x1bP>|kitty(0.36.4)\x1b\\"])
    await terminal.drained()
    expect(terminal.placeholders).toBe(true)
  })

  test("asks once OpenTUI learns it runs inside tmux, from tmux's answer to its XTVERSION", async () => {
    const { terminal, renderer, written, answer, settle } = fixture({ client: undefined })
    await settle()
    expect(written).toEqual([])
    renderer.capabilities.multiplexer = "tmux"
    renderer.emit("capabilities")
    answer(GHOSTTY)
    await terminal.drained()
    expect(written).toEqual([passthrough(QUESTION)])
    expect(terminal.placeholders).toBe(true)
  })

  // With tmux's focus-events the TUI knows when its pane is the active one, which gets the answers.
  test.each([
    ["a focus change", ["focus"]],
    ["a resize while its pane has focus", ["focus", "resize"]],
  ])("with focus events, asks again after %s: another client's terminal and cell", async (_, events) => {
    const { terminal, renderer, written, answer, settle } = fixture(behind)
    answer(GHOSTTY)
    await terminal.drained()
    written.length = 0
    events.forEach((event) => renderer.emit(event))
    await asked(written)
    answer(MAC)
    await settle()
    expect(written).toEqual([passthrough(QUESTION)])
    expect(terminal.cell()).toEqual({ width: 18, height: 37 })
  })

  // Without them (the owner's tmux) a resize also comes to a pane that isn't the active one: a client of another size
  // attaching resizes every window of the session. Its answers would be typed into the active pane's input.
  test.each(["keypress", "paste"])(
    "without focus events, a resize asks nothing until a %s in the pane, then asks once",
    async (event) => {
      const { terminal, renderer, written, answer, settle } = fixture({ ...behind, passthroughMs: 100 })
      answer(GHOSTTY)
      await terminal.drained()
      written.length = 0
      renderer.emit("resize", 120, 40)
      await settle()
      expect(written).toEqual([])
      expect(terminal.placeholders).toBe(true)
      expect(terminal.cell()).toEqual({ width: 19, height: 42 })
      renderer.keyInput.emit(event, {})
      renderer.keyInput.emit(event, {})
      await asked(written)
      answer(MAC)
      await settle()
      renderer.keyInput.emit(event, {})
      await settle()
      expect(written).toEqual([passthrough(QUESTION)])
      expect(terminal.cell()).toEqual({ width: 18, height: 37 })
    },
  )

  test("without focus events, keys ask nothing while no resize came", async () => {
    const { terminal, renderer, written, answer, settle } = fixture(behind)
    answer(GHOSTTY)
    await terminal.drained()
    written.length = 0
    renderer.keyInput.emit("keypress", {})
    await settle()
    expect(written).toEqual([])
  })

  test("a pane that lost focus asks nothing on a resize, and keeps what it knew", async () => {
    const { terminal, renderer, written, answer, settle } = fixture(behind)
    answer(GHOSTTY)
    await terminal.drained()
    written.length = 0
    renderer.emit("blur")
    renderer.emit("resize", 120, 40)
    await settle()
    expect(written).toEqual([])
    expect(terminal.placeholders).toBe(true)
  })

  test("outside tmux nothing is asked", async () => {
    const { written, settle, renderer } = fixture({ client: undefined })
    await settle()
    expect(written).toEqual([])
    expect(renderer.listenerCount("resize")).toBe(0)
  })
})
