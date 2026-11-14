import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// Spec notice-view: a notice line opens to what its message gave the chat; memory's entries one block each.

const MEMORY = "Memory close to the prompt"
const REMINDER = "What changed in the chat's prompt, from its next cold point"
const IMAGES = "The next image will compact this chat first."

test.each([44, 120])("a notice opens to its text, memory's entries laid out, at width %s", async (width) => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width, height: 60, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_notice_view",
    title: "Notice view",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = [
    { id: "user-0", type: "user", text: "Put the login back", time: { created: 0 } },
    {
      id: "notice-memory",
      type: "synthetic",
      description: MEMORY,
      text: [
        "Memory holds these entries close to this prompt; they may be wrong or out of date:",
        "- [7k9fxkcbmav3] Restart the test server after a put (and drop it; always) (verified by Main as build; global; 2026-11-13; basis: login.sh refused (98 s before))",
        "- [0ga7ba99k1nc] A note goes into his current chat (words of Ada, noted as build; role build; 2026-11-14)",
      ].join("\n"),
      metadata: {
        memoryPrompt: { project: "p", recall: "r", entries: ["7k9fxkcbmav3", "0ga7ba99k1nc"], prompt: "user-0" },
      },
      time: { created: 1 },
    },
    {
      id: "notice-reminder",
      type: "synthetic",
      description: REMINDER,
      text: "<system-reminder>\nThe tool read's description changed.\n</system-reminder>",
      metadata: {},
      time: { created: 2 },
    },
    {
      id: "notice-images",
      type: "synthetic",
      description: IMAGES,
      text: IMAGES,
      metadata: { source: "images" },
      time: { created: 3 },
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  const flat = () => setup.captureCharFrame().replace(/\s+/g, "")
  const click = async (label: string) => {
    setup.renderer.clearSelection()
    const lines = setup.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(label.slice(0, 12)))
    expect(y).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(lines[y].indexOf(label.slice(0, 12)) + 1, y)
  }
  try {
    await setup.waitForFrame((frame) => frame.replace(/\s+/g, "").includes(`${MEMORY}·2entries`.replace(/\s+/g, "")))
    await setup.waitForVisualIdle()
    expect(flat()).not.toContain("7k9fxkcbmav3")

    await click(MEMORY)
    await setup.waitForFrame((frame) => frame.includes("0ga7ba99k1nc"))
    const open = flat()
    const order = [
      "Memory holds these entries close to this prompt; they may be wrong or out of date:",
      "7k9fxkcbmav3",
      "verified by Main as build · global · 2026-11-13",
      "Restart the test server after a put (and drop it; always)",
      "basis: login.sh refused (98 s before)",
      "0ga7ba99k1nc",
      "of Ada, noted as build · role build · 2026-11-14",
      "A note goes into his current chat",
    ].map((part) => open.indexOf(part.replace(/\s+/g, "")))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(open).not.toContain("(verifiedbyMain")

    await click(MEMORY)
    await setup.waitForFrame((frame) => !frame.includes("0ga7ba99k1nc"))

    expect(flat()).not.toContain("Thetoolread'sdescriptionchanged.")
    await click(REMINDER)
    await setup.waitForFrame((frame) => frame.replace(/\s+/g, "").includes("Thetoolread'sdescriptionchanged."))
    expect(flat()).not.toContain("system-reminder")

    await setup.waitForVisualIdle()
    const before = setup.captureCharFrame()
    await click(IMAGES)
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).toBe(before)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
