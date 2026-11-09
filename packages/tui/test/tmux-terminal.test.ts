import { describe, expect, test } from "bun:test"
import { notificationEnvironment, protocolFor } from "../src/tmux-terminal"

// openforge (notifications step 2, fix 3): behind tmux, `attention.protocol: auto` asks tmux which terminal the
// client attached to its pane's session is, and sends that terminal's notification sequence.

const tmux = { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%3" }

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

describe("the renderer's environment", () => {
  const asked: string[][] = []
  const answer = (text: string | undefined) => async (args: readonly string[]) => {
    asked.push([...args])
    return text
  }

  test("inside tmux with auto, tmux is asked for the client of this pane's session, and its sequence is set", async () => {
    asked.length = 0
    expect(await notificationEnvironment("auto", tmux, answer("ghostty 1.4.0\n"))).toEqual({
      OPENTUI_NOTIFICATION_PROTOCOL: "osc777",
    })
    expect(asked).toEqual([["display-message", "-p", "-t", "%3", "#{client_termtype}"]])
  })

  test("a terminal it doesn't know, no client, or no answer sets nothing", async () => {
    expect(await notificationEnvironment("auto", tmux, answer("XTerm(390)"))).toBeUndefined()
    expect(await notificationEnvironment("auto", tmux, answer(""))).toBeUndefined()
    expect(await notificationEnvironment("auto", tmux, answer(undefined))).toBeUndefined()
  })

  test("outside tmux, without a pane, or with the protocol already in the environment, tmux is not asked", async () => {
    asked.length = 0
    expect(await notificationEnvironment("auto", {}, answer("ghostty"))).toBeUndefined()
    expect(await notificationEnvironment("auto", { TMUX: tmux.TMUX }, answer("ghostty"))).toBeUndefined()
    expect(
      await notificationEnvironment("auto", { ...tmux, OPENTUI_NOTIFICATION_PROTOCOL: "osc9" }, answer("ghostty")),
    ).toBeUndefined()
    expect(asked).toEqual([])
  })

  test("a protocol that is set wins, inside tmux too, without asking", async () => {
    asked.length = 0
    expect(await notificationEnvironment("osc9", tmux, answer("ghostty"))).toEqual({
      OPENTUI_NOTIFICATION_PROTOCOL: "osc9",
    })
    expect(await notificationEnvironment("osc99", {}, answer("ghostty"))).toEqual({
      OPENTUI_NOTIFICATION_PROTOCOL: "osc99",
    })
    expect(asked).toEqual([])
  })

  test("the real question gives up after its limit and sets nothing", async () => {
    // A `tmux` that never answers: the question is bounded by its limit.
    const started = Date.now()
    expect(
      await notificationEnvironment("auto", tmux, undefined, { command: ["sleep", "5"], limitMs: 100 }),
    ).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("a tmux that fails sets nothing", async () => {
    expect(await notificationEnvironment("auto", tmux, undefined, { command: ["false"] })).toBeUndefined()
  })
})
