import { describe, expect, test } from "bun:test"
import { askTmux, notificationEnvironment, protocolFor, showsPlaceholders } from "../src/tmux-terminal"

// openforge (notifications step 2, fix 3; image-view): behind tmux, the TUI asks tmux once which terminal the client
// attached to its pane's session is, whether it passes sequences through, and the cell size it knows. Notifications
// with `attention.protocol: auto` send that terminal's sequence; images use its graphics when it draws placeholders.

const tmux = { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%3" }
const QUESTION = [
  "display-message",
  "-p",
  "-t",
  "%3",
  "#{client_termtype}\t#{allow-passthrough}\t#{client_cell_width}\t#{client_cell_height}",
  ";",
  "list-clients",
  "-F",
  "\t\t#{client_cell_width}\t#{client_cell_height}",
]

describe("the terminal's sequence", () => {
  test.each([
    ["ghostty 1.4.0", "osc777"],
    ["ghostty 1.3.1-arch2.1", "osc777"],
    ["Konsole 26.08.2", "osc777"],
    ["WezTerm 20240203-110809-5046fc22", "osc777"],
    ["rxvt-unicode", "osc777"],
    ["kitty(0.36.4)", "osc99"],
    ["foot(1.19.0)", "osc99"],
    ["iTerm2 3.5.10", "osc9"],
    ["Apple_Terminal", "osc9"],
    ["XTerm(390)", undefined],
    ["tmux 3.5a", undefined],
    ["", undefined],
  ])("%p sends %p", (termtype, protocol) => {
    expect(protocolFor(termtype)).toBe(protocol as ReturnType<typeof protocolFor>)
  })
})

describe("the terminals that draw placeholders", () => {
  test.each([
    ["kitty(0.36.4)", true],
    ["kitty(0.28.0)", true],
    ["kitty(0.27.1)", false],
    ["ghostty 1.4.0", true],
    ["ghostty 1.10.2", true],
    ["ghostty 2.0.0", true],
    ["ghostty 1.3.1-arch2.1", false],
    ["WezTerm 20240203-110809-5046fc22", false],
    ["iTerm2 3.5.10", false],
    ["tmux 3.5a", false],
    ["", false],
  ])("%p: %p", (termtype, shows) => {
    expect(showsPlaceholders(termtype)).toBe(shows)
  })
})

describe("the question to tmux", () => {
  const asked: string[][] = []
  const answer = (text: string | undefined) => async (args: readonly string[]) => {
    asked.push([...args])
    return text
  }

  test("asks once for this pane's client: its terminal, passthrough and cell size", async () => {
    asked.length = 0
    expect(await askTmux(tmux, answer("ghostty 1.4.0\ton\t19\t42\n\t\t19\t42\n"))).toEqual({
      termtype: "ghostty 1.4.0",
      passthrough: true,
      cell: { width: 19, height: 42 },
    })
    expect(asked).toEqual([QUESTION])
  })

  test("a client without a cell size (docker exec) gets another client's, or none", async () => {
    expect((await askTmux(tmux, answer("ghostty 1.4.0\ton\t0\t0\n\t\t0\t0\n\t\t19\t42\n")))?.cell).toEqual({
      width: 19,
      height: 42,
    })
    const none = await askTmux(tmux, answer("ghostty 1.4.0\ton\t0\t0\n\t\t0\t0\n"))
    expect(none).toEqual({ termtype: "ghostty 1.4.0", passthrough: true })
  })

  test("passthrough off is told; an older tmux without the option passes through", async () => {
    expect((await askTmux(tmux, answer("kitty(0.36.4)\toff\t9\t20\n")))?.passthrough).toBe(false)
    expect((await askTmux(tmux, answer("kitty(0.36.4)\tall\t9\t20\n")))?.passthrough).toBe(true)
    expect((await askTmux(tmux, answer("kitty(0.36.4)\t\t9\t20\n")))?.passthrough).toBe(true)
  })

  test("OPENFORGE_TEST_TERMINAL names the client's terminal instead", async () => {
    expect(
      (await askTmux({ ...tmux, OPENFORGE_TEST_TERMINAL: "kitty(0.42.0)" }, answer("\ton\t0\t0\n")))?.termtype,
    ).toBe("kitty(0.42.0)")
  })

  test("outside tmux or without a pane, tmux is not asked", async () => {
    asked.length = 0
    expect(await askTmux({}, answer("ghostty 1.4.0\ton\t9\t20\n"))).toBeUndefined()
    expect(await askTmux({ TMUX: tmux.TMUX }, answer("ghostty 1.4.0\ton\t9\t20\n"))).toBeUndefined()
    expect(asked).toEqual([])
  })

  test("no answer is no client", async () => {
    expect(await askTmux(tmux, answer(undefined))).toBeUndefined()
  })

  test("the real question gives up after its limit", async () => {
    // A `tmux` that never answers: the question is bounded by its limit.
    const started = Date.now()
    expect(await askTmux(tmux, undefined, { command: ["sh", "-c", "sleep 5"], limitMs: 100 })).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("a tmux that fails is no client", async () => {
    expect(await askTmux(tmux, undefined, { command: ["false"] })).toBeUndefined()
  })
})

describe("the renderer's environment", () => {
  const client = (termtype: string) => ({ termtype, passthrough: true })

  test("with auto, the sequence of tmux's client is set", () => {
    expect(notificationEnvironment("auto", tmux, client("ghostty 1.4.0"))).toEqual({
      OPENTUI_NOTIFICATION_PROTOCOL: "osc777",
    })
  })

  test("a terminal it doesn't know, or no client, sets nothing", () => {
    expect(notificationEnvironment("auto", tmux, client("XTerm(390)"))).toBeUndefined()
    expect(notificationEnvironment("auto", tmux, client(""))).toBeUndefined()
    expect(notificationEnvironment("auto", tmux, undefined)).toBeUndefined()
  })

  test("a protocol already in the environment is left to OpenTUI", () => {
    expect(
      notificationEnvironment("auto", { ...tmux, OPENTUI_NOTIFICATION_PROTOCOL: "osc9" }, client("ghostty 1.4.0")),
    ).toBeUndefined()
  })

  test("a protocol that is set wins, inside tmux too", () => {
    expect(notificationEnvironment("osc9", tmux, client("ghostty 1.4.0"))).toEqual({
      OPENTUI_NOTIFICATION_PROTOCOL: "osc9",
    })
    expect(notificationEnvironment("osc99", {}, undefined)).toEqual({ OPENTUI_NOTIFICATION_PROTOCOL: "osc99" })
  })
})
