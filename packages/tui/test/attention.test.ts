import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Attention } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import { SessionID } from "@opencode/schema/session-id"
import type { AttentionNotifyOptions } from "@opencode/plugin/tui/context"
import { BUILTIN_SOUNDS, SOUND_FILES, createTuiAttention, type AttentionRequest } from "../src/attention"
import { createReport, noPlayers } from "../src/attention-report"
import { resolve, type Resolved } from "../src/config"

// openforge: the TUI still decides what to notify, tells its service of each occurrence, and leaves to the
// service's players (`openforge notify`) what they take over, so nothing comes twice.

const sessionID = SessionID.make("ses_attention")
const done: AttentionNotifyOptions = {
  title: "Fix the build",
  message: "Session done",
  notification: { when: "blurred" },
  sound: { name: "done", when: "always" },
  sessionID,
}

function setup(
  options: { players?: Attention.Players; attention?: Partial<Resolved["attention"]>; report?: boolean } = {},
) {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() }
  const shown: { message: string; title?: string }[] = []
  const played: { file: string; volume?: number }[] = []
  const reported: Attention.Occurrence[] = []
  const attention = createTuiAttention({
    renderer: {
      isDestroyed: false,
      on: (event, listener) => listeners[event].add(listener),
      off: (event, listener) => listeners[event].delete(listener),
      triggerNotification: (message, title) => {
        shown.push({ message, title })
        return true
      },
    },
    config: {
      attention: {
        ...resolve({}, { terminalSuspend: true, environment: {} }).attention,
        ...options.attention,
      },
    },
    audio: {
      // A sound is its file's index here; the TUI only hands it back to play().
      loadSoundFile: async (file) => Object.values(SOUND_FILES).concat(file).indexOf(file),
      play: (sound, playOptions) => {
        played.push({
          file: Object.values(SOUND_FILES).concat("custom")[sound] ?? "custom",
          volume: playOptions?.volume,
        })
        return 1
      },
    },
    report:
      options.report === false
        ? undefined
        : async (occurrence) => {
            reported.push(occurrence)
            return options.players ?? noPlayers
          },
  })
  return {
    attention,
    shown,
    played,
    reported,
    focus: (event: "focus" | "blur") => listeners[event].forEach((listener) => listener()),
  }
}

describe("focus rule", () => {
  test("while the window's focus is unknown, a notification counts as not focused and shows", async () => {
    const tui = setup()
    expect(await tui.attention.notify(done)).toEqual({ ok: true, notification: true, sound: true })
    expect(tui.shown).toEqual([{ message: "Session done", title: "Fix the build" }])
  })

  test("a focused window shows none and still plays the sound; a blurred one shows it", async () => {
    const tui = setup()
    tui.focus("focus")
    expect(await tui.attention.notify(done)).toEqual({ ok: true, notification: false, sound: true })
    expect(tui.shown).toEqual([])
    tui.focus("blur")
    expect(await tui.attention.notify(done)).toEqual({ ok: true, notification: true, sound: true })
    expect(tui.shown).toHaveLength(1)
  })

  test("a notification asked for a focused window still needs focus to be known", async () => {
    const tui = setup()
    expect(await tui.attention.notify({ ...done, notification: { when: "focused" }, sound: false })).toEqual({
      ok: false,
      notification: false,
      sound: false,
      skipped: "focus_unknown",
    })
  })
})

describe("what a TUI tells its service", () => {
  test("each occurrence once: kind, chat, title, message, whether it notifies, its sound and the window's focus", async () => {
    const tui = setup({ attention: { sounds: { question: "/sounds/question.wav" } } })
    await tui.attention.notify(done)
    tui.focus("focus")
    await tui.attention.notify({
      message: "Input\nneeds response",
      notification: { when: "blurred" },
      sound: { name: "question", when: "always" },
      sessionID,
    })
    expect(tui.reported).toEqual([
      {
        kind: "done",
        sessionID,
        title: "Fix the build",
        message: "Session done",
        notify: true,
        sound: { name: "done", file: undefined },
        focused: false,
      },
      {
        kind: "question",
        sessionID,
        title: Product.name,
        message: "Input needs response",
        notify: false,
        sound: { name: "question", file: "/sounds/question.wav" },
        focused: true,
      },
    ])
  })

  test("a subagent's sound-only occurrence notifies nobody, and a form no chat asked for has no chat", async () => {
    const tui = setup()
    await tui.attention.notify({ ...done, notification: false, sound: { name: "subagent_done" } })
    await tui.attention.notify({ ...done, sessionID: "global" })
    expect(tui.reported.map((occurrence) => [occurrence.notify, occurrence.sessionID])).toEqual([
      [false, sessionID],
      [true, undefined],
    ])
  })

  test("with sounds off it reports no sound, and with notifications off it notifies nobody", async () => {
    const quiet = setup({ attention: { sound: false } })
    await quiet.attention.notify(done)
    expect(quiet.reported[0]).toMatchObject({ notify: true, sound: undefined })
    const silent = setup({ attention: { notifications: false } })
    await silent.attention.notify(done)
    expect(silent.reported[0]).toMatchObject({ notify: false, sound: { name: "done" } })
  })

  test("nothing is reported while attention is off or the message is empty", async () => {
    const off = setup({ attention: { notifications: false, sound: false } })
    expect((await off.attention.notify(done)).skipped).toBe("attention_disabled")
    const empty = setup()
    expect((await empty.attention.notify({ ...done, message: " \n " })).skipped).toBe("empty_message")
    expect([...off.reported, ...empty.reported]).toEqual([])
  })
})

describe("no doubles", () => {
  test("with no player connected the TUI plays and shows everything itself", async () => {
    const tui = setup({ players: { sound: false, desktop: false } })
    await tui.attention.notify(done)
    expect(tui.played).toEqual([{ file: BUILTIN_SOUNDS.done, volume: 0.4 }])
    expect(tui.shown).toHaveLength(1)
  })

  test("while a player is connected the TUI plays no sound, and still sends its escape sequence", async () => {
    const tui = setup({ players: { sound: true, desktop: false } })
    expect(await tui.attention.notify(done)).toEqual({ ok: true, notification: true, sound: false })
    expect(tui.played).toEqual([])
    expect(tui.shown).toHaveLength(1)
  })

  test("while a --desktop player is connected the TUI sends no escape sequence either", async () => {
    const tui = setup({ players: { sound: true, desktop: true } })
    expect(await tui.attention.notify(done)).toEqual({ ok: true, notification: false, sound: false })
    expect(tui.played).toEqual([])
    expect(tui.shown).toEqual([])
  })

  test("without a report (no service) the TUI does it all itself", async () => {
    const tui = setup({ report: false })
    await tui.attention.notify(done)
    expect(tui.played).toHaveLength(1)
    expect(tui.shown).toHaveLength(1)
  })
})

describe("the report", () => {
  const occurrence: Attention.Occurrence = {
    kind: "done",
    title: "Fix the build",
    message: "Session done",
    notify: true,
    focused: false,
  }
  const api = (occurrence: (signal?: AbortSignal) => Promise<Attention.Players>) =>
    ({
      experimental: {
        attention: { occurrence: (_: unknown, options?: { signal?: AbortSignal }) => occurrence(options?.signal) },
      },
    }) as unknown as OpenCodeClient

  test("answers the service's players and logs what the TUI leaves to them", async () => {
    const lines: unknown[] = []
    const report = createReport(
      () => api(async () => ({ sound: true, desktop: false })),
      (message, tags) => lines.push({ message, ...tags }),
    )
    expect(await report({ ...occurrence, sound: { name: "done" } })).toEqual({ sound: true, desktop: false })
    expect(lines).toEqual([
      {
        message: "attention occurrence reported",
        kind: "done",
        sessionID: undefined,
        sound: "player",
        notification: "own",
      },
    ])
  })

  test("a service that fails, or doesn't answer within a second, leaves everything to the TUI", async () => {
    const failing = createReport(
      () => api(() => Promise.reject(new Error("gone"))),
      () => {},
    )
    expect(await failing(occurrence)).toEqual(noPlayers)
    const silent = createReport(
      () =>
        api(
          (signal) =>
            new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ),
      () => {},
    )
    const started = performance.now()
    expect(await silent(occurrence)).toEqual(noPlayers)
    expect(performance.now() - started).toBeGreaterThanOrEqual(900)
  })
})

// openforge (notifications step 2): the TUI's own events choose their sounds; a plugin's request plays its kind's.
describe("an event's sound", () => {
  const event = (sound: AttentionRequest["sound"]): AttentionRequest => ({
    kind: "reply",
    sessionID,
    title: "Fix the build",
    message: "Session replied",
    notification: "blurred",
    sound,
  })

  test("a built-in sound goes to the service by its ID, and plays here without a player", async () => {
    const tui = setup()
    await tui.attention.raise(event({ when: "always", id: "alert-07" }))
    expect(tui.reported[0].sound).toEqual({ name: "reply", id: "alert-07", file: undefined })
    expect(tui.played).toEqual([{ file: SOUND_FILES["alert-07"], volume: 0.4 }])
  })

  test("a file goes as a file", async () => {
    const tui = setup()
    await tui.attention.raise(event({ when: "always", file: "/sounds/mine.wav" }))
    expect(tui.reported[0].sound).toEqual({ name: "reply", id: undefined, file: "/sounds/mine.wav" })
  })

  test("no sound: none reported and none played; the notification still shows", async () => {
    const tui = setup()
    expect(await tui.attention.raise(event(false))).toEqual({ ok: true, notification: true, sound: false })
    expect(tui.reported[0]).toMatchObject({ kind: "reply", notify: true, sound: undefined })
    expect(tui.played).toEqual([])
  })

  test("the machine's switches still win: Sounds off plays no event's sound", async () => {
    const tui = setup({ attention: { sound: false } })
    await tui.attention.raise(event({ when: "always", id: "alert-07" }))
    expect(tui.reported[0].sound).toBeUndefined()
  })

  test("a plugin's request plays its kind's built-in sound; a permission's is bip-bop-03", async () => {
    const tui = setup()
    await tui.attention.notify({ message: "Permission needs input", sound: { name: "permission" }, sessionID })
    expect(tui.played).toEqual([{ file: SOUND_FILES["bip-bop-03"], volume: 0.4 }])
    expect(BUILTIN_SOUNDS.permission).toBe(SOUND_FILES["bip-bop-03"])
  })

  test("every built-in sound is in this build", () => {
    expect(Object.keys(SOUND_FILES)).toHaveLength(45)
    for (const file of Object.values(SOUND_FILES)) expect(Bun.file(file).size).toBeGreaterThan(0)
  })
})
