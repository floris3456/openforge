import { describe, expect, test } from "bun:test"
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing"
import { EventEmitter } from "node:events"
import { createTmuxPassthrough, QUESTION, readReply } from "../src/tmux-passthrough"

// openforge (spec image-view, "When placeholders are used"): a TUI inside tmux that can't ask tmux asks the terminal
// behind it through tmux's passthrough, and takes the answers out of its input. What the answers are, byte for byte, as
// tmux 3.7c and 3.8 hand them to the pane: run/evidence/sharp-images/verify-1 in the QuettaForge workspace.

const GHOSTTY = ["\x1b_Gi=7254017;OK\x1b\\", "\x1b[6;42;19t", "\x1bP>|ghostty 1.4.0-arch1.1\x1b\\"]

function fixture(limitMs = 1000) {
  const handlers: ((sequence: string) => boolean)[] = []
  const renderer = Object.assign(new EventEmitter(), {
    prependInputHandler: (handler: (sequence: string) => boolean) => handlers.unshift(handler),
    removeInputHandler: (handler: (sequence: string) => boolean) => handlers.splice(handlers.indexOf(handler), 1),
  })
  const sent: string[] = []
  const passthrough = createTmuxPassthrough({ renderer, send: (sequence) => sent.push(sequence), limitMs })
  /** Input as OpenTUI hands it to its handlers: whether one took it. */
  const input = (sequence: string) => handlers.some((handler) => handler(sequence))
  return { renderer, sent, passthrough, input, handlers }
}

describe("asking the terminal behind tmux", () => {
  test("whether it draws Kitty graphics, its cell and its name, in the order it answers", () => {
    const { passthrough, sent } = fixture()
    void passthrough.ask()
    expect(sent).toEqual([QUESTION])
    expect(QUESTION).toBe("\x1b_Gi=7254017,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[>q")
  })

  test("Ghostty's answers say it all, and the last one ends the question at once", async () => {
    const { passthrough, input } = fixture(60_000)
    const answer = passthrough.ask()
    expect(GHOSTTY.map(input)).toEqual([true, true, true])
    expect(await answer).toEqual({
      termtype: "ghostty 1.4.0-arch1.1",
      passthrough: true,
      graphics: true,
      cell: { width: 19, height: 42 },
    })
  })

  test("a terminal without Kitty graphics answers only its name", async () => {
    const { passthrough, input } = fixture(60_000)
    const answer = passthrough.ask()
    input("\x1bP>|XTerm(390)\x1b\\")
    expect(await answer).toEqual({ termtype: "XTerm(390)", passthrough: true, graphics: false })
  })

  test("a refused Kitty query is no", async () => {
    const { passthrough, input } = fixture(60_000)
    const answer = passthrough.ask()
    input("\x1b_Gi=7254017;ENOTSUPPORTED:no graphics\x1b\\")
    input("\x1bP>|kitty(0.36.4)\x1b\\")
    expect((await answer)?.graphics).toBe(false)
  })

  test("no answer within the limit is nothing, so what was known stays", async () => {
    const { passthrough } = fixture(5)
    expect(await passthrough.ask()).toBeUndefined()
  })

  test("a question already out is shared", async () => {
    const { passthrough, sent, input } = fixture(60_000)
    const first = passthrough.ask()
    const second = passthrough.ask()
    expect(sent).toHaveLength(1)
    GHOSTTY.forEach(input)
    expect(await second).toEqual((await first)!)
  })
})

describe("the input", () => {
  test("answers are taken out, also late ones; anything else is left to OpenTUI", async () => {
    const { passthrough, input } = fixture(5)
    expect(await passthrough.ask()).toBeUndefined()
    expect(GHOSTTY.map(input)).toEqual([true, true, true])
    // tmux's own answer to OpenTUI's XTVERSION, OpenTUI's own Kitty query, keys and other reports.
    expect(input("\x1bP>|tmux 3.8\x1b\\")).toBe(false)
    expect(input("\x1b_Gi=31337;OK\x1b\\")).toBe(false)
    expect(input("a")).toBe(false)
    expect(input("\x1b[4;1260;1900t")).toBe(false)
    expect(input("\x1b[?62;22;52c")).toBe(false)
  })

  test("the readings", () => {
    expect(readReply("\x1b[6;0;0t")).toEqual({})
    expect(readReply("\x1b_Gi=7254017,p=3;OK\x1b\\")).toEqual({ graphics: true })
    expect(readReply("\x1bP>|WezTerm 20240203-110809-5046fc22\x1b\\")).toEqual({
      termtype: "WezTerm 20240203-110809-5046fc22",
    })
  })

  test("dispose leaves the input alone and ends a question", async () => {
    const { passthrough, handlers, renderer } = fixture(60_000)
    const answer = passthrough.ask()
    passthrough.dispose()
    expect(await answer).toBeUndefined()
    expect(handlers).toEqual([])
    expect(renderer.listenerCount("focus") + renderer.listenerCount("blur")).toBe(0)
  })
})

describe("the pane", () => {
  // tmux hands the answers to the pane active in the client's window. With tmux's focus-events a TUI knows when its
  // pane isn't that one.
  test("a TUI whose pane lost focus asks nothing, until it has it again", async () => {
    const { passthrough, sent, renderer, input } = fixture(60_000)
    renderer.emit("blur")
    expect(await passthrough.ask()).toBeUndefined()
    expect(sent).toEqual([])
    renderer.emit("focus")
    const answer = passthrough.ask()
    expect(sent).toEqual([QUESTION])
    GHOSTTY.forEach(input)
    expect((await answer)?.termtype).toBe("ghostty 1.4.0-arch1.1")
  })
})

describe("in OpenTUI's input", () => {
  // The renderer's own parser hands each answer whole to the handler, as a reply and not as typed keys.
  test("the answers reach the handler whole, and none of them as keys", async () => {
    await using setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
    setRendererCapabilities(setup.renderer, { multiplexer: "tmux", terminal: { name: "tmux", version: "3.8" } })
    const keys: string[] = []
    setup.renderer.keyInput.on("keypress", (key: { sequence: string }) => keys.push(key.sequence))
    const passthrough = createTmuxPassthrough({ renderer: setup.renderer, send: () => {} })
    const answer = passthrough.ask()
    setup.renderer.stdin.emit("data", Buffer.from(GHOSTTY.join(""), "latin1"))
    expect(await answer).toEqual({
      termtype: "ghostty 1.4.0-arch1.1",
      passthrough: true,
      graphics: true,
      cell: { width: 19, height: 42 },
    })
    setup.renderer.stdin.emit("data", Buffer.from("x"))
    expect(keys).toEqual(["x"])
    passthrough.dispose()
  })
})
