import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { AttentionRequest } from "../src/attention"
import { createAttentionEvents } from "../src/attention-events"
import { resolve, type Info } from "../src/config"

// openforge (notifications step 2, "Events and their settings"): which event a TUI raises when, with which
// notification and sound, from `attention.events` in cli.json.

// chat ─ child ─ grand ─ great; other is another top-level chat.
const sessions: Record<string, { id: string; title: string; parentID?: string; location: { directory: string } }> = {
  chat: { id: "chat", title: "The chat", location: { directory: "/project" } },
  child: { id: "child", title: "A subagent", parentID: "chat", location: { directory: "/project" } },
  grand: { id: "grand", title: "Its subagent", parentID: "child", location: { directory: "/project" } },
  great: { id: "great", title: "Three down", parentID: "grand", location: { directory: "/project" } },
  other: { id: "other", title: "Another chat", location: { directory: "/project" } },
}

type Shell = { status: string; metadata: Record<string, unknown> }

function setup(attention: Info["attention"] = {}, options: { ours?: string[] } = {}) {
  const handlers = new Map<string, ((event: OpenCodeEvent) => void)[]>()
  const raised: AttentionRequest[] = []
  const toasts: string[] = []
  const running = new Set<string>()
  const shells: Shell[] = []
  const asked: string[] = []
  const gate = { shells: undefined as Promise<void> | undefined }
  const settings = resolve({ attention }, { terminalSuspend: true, environment: {} }).attention
  const dispose = createAttentionEvents({
    data: {
      on: ((type: string, handler: (event: OpenCodeEvent) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () =>
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((item) => item !== handler),
          )
      }) as never,
      session: {
        get: ((id: string) => sessions[id]) as never,
        sync: async () => {},
        family: (id) => Object.keys(sessions).filter((other) => root(other) === root(id)),
        status: (id) => (running.has(id) ? "running" : "idle"),
      },
    },
    shells: async (location) => {
      asked.push(location?.directory ?? "")
      await gate.shells
      return shells
    },
    settings: () => settings,
    raise: async (request) => {
      raised.push(request)
    },
    ours: async (id) => (options.ours ?? ["chat"]).includes(root(id)),
    failed: (sessionID, message) => toasts.push(`${sessionID}: ${message}`),
  })
  let seq = 0
  const emit = (type: string, data: Record<string, unknown>) =>
    (handlers.get(type) ?? []).forEach((handler) => handler({ id: `evt_${++seq}`, created: seq, type, data } as never))
  const settle = () => Bun.sleep(1)
  return {
    raised,
    toasts,
    running,
    shells,
    asked,
    gate,
    dispose,
    /** What was raised, as `kind:session` with its sound and whether it notifies. */
    seen: () =>
      raised.map(
        (item) =>
          `${item.kind}:${item.sessionID} ${item.notification === false ? "-" : "notify"} ${item.sound === false ? "-" : (item.sound.id ?? item.sound.file)}`,
      ),
    async turn(sessionID: string) {
      emit("session.execution.started", { sessionID })
      emit("session.execution.succeeded", { sessionID })
      await settle()
    },
    async fail(sessionID: string, type = "unknown", message = "boom") {
      emit("session.execution.started", { sessionID })
      emit("session.execution.failed", { sessionID, error: { type, message } })
      await settle()
    },
    emit,
    settle,
  }
}

function root(id: string): string {
  const parent = sessions[id]?.parentID
  return parent ? root(parent) : id
}

describe("Done and Reply", () => {
  test("a chat's turn with nothing it started still running is Done, with its notification and bip-bop-01", async () => {
    const tui = setup()
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
    expect(tui.raised[0]).toMatchObject({ title: "The chat", message: "Session done" })
  })

  test("while a subagent at any depth still runs, the reply is no Done; Reply is off by default", async () => {
    const tui = setup()
    tui.running.add("grand")
    await tui.turn("chat")
    expect(tui.seen()).toEqual([])
    tui.running.delete("grand")
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
  })

  test("while a shell of the chat or of one of its subagents runs, the reply is no Done", async () => {
    const tui = setup({ events: { reply: { notification: true, sound: "yup-02" } } })
    tui.shells.push({ status: "running", metadata: { sessionID: "chat" } })
    await tui.turn("chat")
    tui.shells.splice(0, 1, { status: "running", metadata: { sessionID: "grand" } })
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["reply:chat notify yup-02", "reply:chat notify yup-02"])
    // The shells of the chat's own location were asked for.
    expect(tui.asked).toEqual(["/project", "/project"])
  })

  test("a shell of another chat, or one that ended, doesn't hold Done back", async () => {
    const tui = setup()
    tui.shells.push(
      { status: "running", metadata: { sessionID: "other" } },
      { status: "exited", metadata: { sessionID: "chat" } },
    )
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
  })

  test("a background shell's end runs the chat again, and that turn's reply is Done", async () => {
    const tui = setup()
    tui.shells.push({ status: "running", metadata: { sessionID: "chat" } })
    await tui.turn("chat")
    expect(tui.seen()).toEqual([])
    tui.shells[0].status = "exited"
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
  })

  test("a reply that is Done raises only Done, also with Reply on", async () => {
    const tui = setup({ events: { reply: { notification: true, sound: "yup-02" } } })
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
  })

  test("with Done off, a reply that is Done raises Reply, when Reply is on", async () => {
    const off = { notification: false, sound: "off" } as const
    const tui = setup({ events: { done: off, reply: { notification: false, sound: "bip-bop-05" } } })
    await tui.turn("chat")
    expect(tui.seen()).toEqual(["reply:chat - bip-bop-05"])
    const quiet = setup({ events: { done: off } })
    await quiet.turn("chat")
    expect(quiet.seen()).toEqual([])
    // Nothing to raise, so nothing is asked of the service either.
    expect(quiet.asked).toEqual([])
  })

  test("a chat that runs again before its shells are known replied, it isn't done", async () => {
    const tui = setup({ events: { reply: { notification: true } } })
    const release = Promise.withResolvers<void>()
    tui.gate.shells = release.promise
    tui.emit("session.execution.started", { sessionID: "chat" })
    tui.emit("session.execution.succeeded", { sessionID: "chat" })
    await tui.settle()
    tui.emit("session.execution.started", { sessionID: "chat" })
    release.resolve()
    await tui.settle()
    expect(tui.seen()).toEqual(["reply:chat notify -"])
  })

  test("an interrupted turn raises nothing, nor does a duplicate end of it", async () => {
    const tui = setup({ events: { reply: { notification: true } } })
    tui.emit("session.execution.started", { sessionID: "chat" })
    tui.emit("session.execution.interrupted", { sessionID: "chat" })
    tui.emit("session.execution.succeeded", { sessionID: "chat" })
    await tui.settle()
    expect(tui.seen()).toEqual([])
  })

  test("an end without its start (the TUI started later) still raises, once per turn", async () => {
    const tui = setup()
    tui.emit("session.execution.succeeded", { sessionID: "chat" })
    tui.emit("session.execution.succeeded", { sessionID: "chat" })
    await tui.settle()
    expect(tui.seen()).toEqual(["done:chat notify bip-bop-01"])
  })

  test("another TUI's chat asks nothing and raises nothing", async () => {
    const tui = setup({}, { ours: ["chat"] })
    await tui.turn("other")
    expect(tui.asked).toEqual([])
    expect(tui.seen()).toEqual([])
  })
})

describe("Subagent done", () => {
  test("is off by default", async () => {
    const tui = setup()
    await tui.turn("child")
    expect(tui.seen()).toEqual([])
  })

  test("raises down to its levels: 1 is the chat's own subagents", async () => {
    const one = setup({ events: { subagent_done: { notification: true, sound: "yup-01" } } })
    await one.turn("child")
    await one.turn("grand")
    expect(one.seen()).toEqual(["subagent_done:child notify yup-01"])
    const two = setup({ events: { subagent_done: { sound: "yup-01", levels: 2 } } })
    await two.turn("child")
    await two.turn("grand")
    await two.turn("great")
    expect(two.seen()).toEqual(["subagent_done:child - yup-01", "subagent_done:grand - yup-01"])
  })

  test("not while work it started still runs", async () => {
    const tui = setup({ events: { subagent_done: { sound: "yup-01", levels: 3 } } })
    tui.running.add("grand")
    await tui.turn("child")
    tui.running.clear()
    tui.shells.push({ status: "running", metadata: { sessionID: "great" } })
    await tui.turn("grand")
    // A running shell of the chat itself, above it, is not its work.
    tui.shells.splice(0, 1, { status: "running", metadata: { sessionID: "chat" } })
    await tui.turn("great")
    expect(tui.seen()).toEqual(["subagent_done:great - yup-01"])
  })
})

describe("Question", () => {
  test("a form or a permission that waits, at any depth, with its notification and bip-bop-03", async () => {
    const tui = setup()
    tui.emit("form.created", { form: { id: "frm_1", sessionID: "great", title: "Pick one", fields: [] } })
    tui.emit("permission.asked", {
      id: "per_1",
      sessionID: "grand",
      action: "shell",
      resources: [],
      metadata: {},
      save: [],
    })
    // Raised once while it waits; again after it was answered and asked again.
    tui.emit("permission.asked", {
      id: "per_1",
      sessionID: "grand",
      action: "shell",
      resources: [],
      metadata: {},
      save: [],
    })
    tui.emit("permission.replied", { sessionID: "grand", requestID: "per_1", reply: "once" })
    tui.emit("permission.asked", {
      id: "per_1",
      sessionID: "grand",
      action: "shell",
      resources: [],
      metadata: {},
      save: [],
    })
    expect(tui.seen()).toEqual([
      "question:great notify bip-bop-03",
      "permission:grand notify bip-bop-03",
      "permission:grand notify bip-bop-03",
    ])
    expect(tui.raised[0]).toMatchObject({ title: "Pick one", message: "Input needs response" })
  })

  test("its sound and switch apply to both; Question off raises neither", async () => {
    const tui = setup({ events: { question: { notification: false, sound: "alert-04" } } })
    tui.emit("form.created", { form: { id: "frm_1", sessionID: "chat", title: "Pick one", fields: [] } })
    tui.emit("permission.asked", {
      id: "per_1",
      sessionID: "chat",
      action: "edit",
      resources: [],
      metadata: {},
      save: [],
    })
    expect(tui.seen()).toEqual(["question:chat - alert-04", "permission:chat - alert-04"])
    const off = setup({ events: { question: { notification: false, sound: "off" } } })
    off.emit("permission.asked", {
      id: "per_1",
      sessionID: "chat",
      action: "edit",
      resources: [],
      metadata: {},
      save: [],
    })
    expect(off.seen()).toEqual([])
  })
})

describe("Error", () => {
  test("a failed turn of the chat: its notification, nope-03 and upstream's toast; no Done after it", async () => {
    const tui = setup()
    await tui.fail("chat")
    tui.emit("session.execution.succeeded", { sessionID: "chat" })
    await tui.settle()
    expect(tui.seen()).toEqual(["error:chat notify nope-03"])
    expect(tui.raised[0]).toMatchObject({ message: "boom" })
    expect(tui.toasts).toEqual(["chat: boom"])
  })

  test("a subagent's, only within the levels while Subagent done is on; the toast always", async () => {
    const off = setup()
    await off.fail("child")
    expect(off.seen()).toEqual([])
    expect(off.toasts).toEqual(["child: boom"])
    const on = setup({ events: { subagent_done: { notification: true } } })
    await on.fail("child")
    await on.fail("grand")
    expect(on.seen()).toEqual(["error:child notify nope-03"])
  })

  test("the free-tier and Go limits raise nothing, as upstream", async () => {
    const tui = setup()
    await tui.fail("chat", "provider.free-limit")
    await tui.fail("chat", "provider.go-limit")
    expect(tui.seen()).toEqual([])
    expect(tui.toasts).toEqual([])
  })
})

describe("sounds", () => {
  test("a file plays as a file; an event whose sound is off still notifies, without a sound", async () => {
    const tui = setup({ events: { done: { sound: "/home/me/done.wav" }, error: { sound: "off" } } })
    await tui.turn("chat")
    await tui.fail("chat")
    expect(tui.seen()).toEqual(["done:chat notify /home/me/done.wav", "error:chat notify -"])
    expect(tui.raised[0].sound).toEqual({ when: "always", file: "/home/me/done.wav" })
  })

  test("a file in the old attention.sounds plays for its event while that event's sound is unset", async () => {
    const tui = setup({
      sounds: { done: "/old/done.wav", question: "/old/question.wav", permission: "/old/permission.wav" },
      events: { error: { notification: true } },
    })
    await tui.turn("chat")
    tui.emit("form.created", { form: { id: "frm_1", sessionID: "chat", title: "Pick one", fields: [] } })
    tui.emit("permission.asked", {
      id: "per_1",
      sessionID: "chat",
      action: "edit",
      resources: [],
      metadata: {},
      save: [],
    })
    expect(tui.seen()).toEqual([
      "done:chat notify /old/done.wav",
      "question:chat notify /old/question.wav",
      "permission:chat notify /old/permission.wav",
    ])
    const set = setup({
      sounds: { done: "/old/done.wav", permission: "/old/p.wav" },
      events: { done: { sound: "alert-01" }, question: { sound: "nope-01" } },
    })
    await set.turn("chat")
    set.emit("permission.asked", {
      id: "per_1",
      sessionID: "chat",
      action: "edit",
      resources: [],
      metadata: {},
      save: [],
    })
    expect(set.seen()).toEqual(["done:chat notify alert-01", "permission:chat notify nope-01"])
  })
})

test("disposing stops every event", async () => {
  const tui = setup()
  tui.dispose()
  await tui.turn("chat")
  expect(tui.seen()).toEqual([])
})
