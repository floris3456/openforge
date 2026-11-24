import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { SessionInfo } from "@opencode/client"
import { SESSION_SIDEBAR_WIDTH } from "../src/ui/layout"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { until } from "./fixture/wait"

// The owner, 2026-11-24: "please make the sidebar also exclusive for every chat on the same server". The sidebar's
// visibility and the state of its Todo and MCP sections belong to the chat they were changed in, kept in the TUI's
// client-local storage; the Sidebar setting stays the default for chats without their own.

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  ...extra,
})

const PARENT = session("ses_parent", { title: "Parent chat" })
const CHILD = session("ses_child", { title: "Subagent chat", parentID: PARENT.id, agent: "general" })
const OTHER = session("ses_other", { title: "Other chat" })
const WIDE = 170

const todos = (sessionID: string) => ({
  id: `msg_${sessionID}_todo`,
  type: "assistant",
  agent: "build",
  model: { providerID: "fixture", id: "fixture" },
  time: { created: 1, completed: 2 },
  content: [
    {
      type: "tool",
      id: `call_${sessionID}_todo`,
      name: "todowrite",
      time: { created: 1, completed: 2 },
      state: {
        status: "completed",
        input: {
          todos: [
            { content: "First step", status: "completed" },
            { content: "Second step", status: "in_progress" },
            { content: "Third step", status: "pending" },
          ],
        },
        content: [{ type: "text", text: "updated" }],
      },
    },
  ],
})

const servers = ["alpha", "beta", "gamma"].map((name) => ({ name, status: { status: "connected" } }))

/** A TUI window on `sessionID`, its client-local storage in `state` (shared by every window and restart of a test). */
async function window(input: {
  state: string
  sessionID: string
  width?: number
  config?: { sidebar?: "auto" | "hide" }
  /** Chats the service no longer has: it answers them not found. */
  gone?: string[]
}) {
  const sessions = [PARENT, CHILD, OTHER].filter((item) => !input.gone?.includes(item.id))
  const asked: string[] = []
  const setup = await createAppFixture({
    width: input.width ?? WIDE,
    height: 36,
    state: input.state,
    config: { animations: false, tabs: { mode: "off" }, session: { sidebar: input.config?.sidebar } },
    args: { sessionID: input.sessionID },
    fetch: (url) => {
      const id = url.pathname.match(/^\/api\/session\/(ses_\w+)$/)?.[1]
      if (id) {
        asked.push(id)
        const known = sessions.find((item) => item.id === id)
        if (known) return json({ data: known })
        return json(
          { _tag: "SessionNotFoundError", sessionID: id, message: `Session not found: ${id}` },
          { status: 404 },
        )
      }
      const message = url.pathname.match(/^\/api\/session\/(ses_\w+)\/message$/)?.[1]
      if (message) return json({ data: message === CHILD.id ? [] : [todos(message)], cursor: {} })
      if (/^\/api\/session\/ses_\w+\/(inbox|permission|form)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === PARENT.id)
        return json({ data: [CHILD], cursor: {} })
      if (url.pathname === "/api/mcp")
        return json({
          location: { directory, project: { id: "proj_test", directory, canonical: directory } },
          data: servers,
        })
      return undefined
    },
  })
  await setup.ready
  return Object.assign(setup, { asked, width: input.width ?? WIDE })
}

type Window = Awaited<ReturnType<typeof window>>

/** The sidebar's columns of each line: the window's last SESSION_SIDEBAR_WIDTH. */
const sidebarText = (setup: Window, frame = setup.captureCharFrame()) =>
  frame
    .split("\n")
    .map((line) => line.slice(setup.width - SESSION_SIDEBAR_WIDTH))
    .join("\n")

/** Whether the sidebar is on screen with the chat's title, its Todo and its MCP sections drawn. */
const shown = (setup: Window, title: string) => (frame: string) => {
  const text = sidebarText(setup, frame)
  return text.includes(title) && text.includes("Todo") && text.includes("MCP")
}

/** The chat is on screen, its last message drawn, and no sidebar beside it. */
const hidden = (setup: Window) => (frame: string) =>
  frame.includes("Third step") && !sidebarText(setup, frame).includes("MCP")

const toggle = (setup: Window) => {
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("b")
}

async function clickSection(setup: Window, name: string) {
  const lines = setup.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.slice(setup.width - SESSION_SIDEBAR_WIDTH).includes(name))
  if (row === -1) throw new Error(`No ${name} section in the sidebar:\n${setup.captureCharFrame()}`)
  await setup.mockMouse.click(lines[row]!.lastIndexOf(name), row)
}

/**
 * Resolves once the window's frame matches. What these tests wait on comes through requests and storage writes, not
 * frames, so it is polled against the wall clock (the tui-tests skill), with the frame shown on failure.
 */
async function appears(setup: Window, match: (frame: string) => boolean) {
  await until(() => match(setup.captureCharFrame()), 10_000).catch(() => {
    throw new Error(`the frame did not match within 10 s:\n${setup.captureCharFrame()}`)
  })
}

/** The other window has read the shared storage file once the write reached it; give it the time it takes. */
async function settle(setup: Window) {
  await Bun.sleep(150)
  await setup.waitForVisualIdle({ quietFrames: 2 })
}

/** The chats with state of their own in the storage file, none before its first write. */
const stored = (state: string) => {
  const file = path.join(state, "test", "tui", "session-sidebar.json")
  if (!existsSync(file)) return []
  return Object.keys((JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, unknown> }).sessions)
}

describe("the sidebar of each chat", () => {
  test("hiding it in one chat leaves another chat's, and the Sidebar setting", async () => {
    await using state = await tmpdir()
    await using setup = await window({ state: state.path, sessionID: CHILD.id })
    const inChild = (frame: string) => frame.includes("No active subagents")
    await appears(setup, (frame) => sidebarText(setup, frame).includes("Subagent chat") && inChild(frame))
    toggle(setup)
    await appears(setup, (frame) => inChild(frame) && !sidebarText(setup, frame).includes("Subagent chat"))
    // Escape leaves the subagent's chat for its parent's, which keeps its sidebar.
    setup.mockInput.pressEscape()
    await appears(setup, shown(setup, "Parent chat"))
    // The setting in cli.json is the default for other chats; the key no longer writes it.
    expect(setup.config().session?.sidebar).toBeUndefined()
  })

  test("two windows, each on its own chat: hiding it in one leaves the other, and both keep theirs after a restart", async () => {
    await using state = await tmpdir()
    {
      await using first = await window({ state: state.path, sessionID: PARENT.id })
      await using second = await window({ state: state.path, sessionID: OTHER.id })
      await appears(first, shown(first, "Parent chat"))
      await appears(second, shown(second, "Other chat"))
      toggle(first)
      await appears(first, hidden(first))
      await settle(second)
      expect(shown(second, "Other chat")(second.captureCharFrame())).toBe(true)
    }
    await using first = await window({ state: state.path, sessionID: PARENT.id })
    await using second = await window({ state: state.path, sessionID: OTHER.id })
    await appears(first, hidden(first))
    await appears(second, shown(second, "Other chat"))
    // On, off, on: one press each, in the chat on screen only.
    toggle(first)
    await appears(first, shown(first, "Parent chat"))
    toggle(second)
    await appears(second, hidden(second))
    await settle(first)
    expect(shown(first, "Parent chat")(first.captureCharFrame())).toBe(true)
  })

  test("a chat without its own follows the Sidebar setting, which the key does not change", async () => {
    await using state = await tmpdir()
    await using setup = await window({ state: state.path, sessionID: OTHER.id, config: { sidebar: "hide" } })
    await appears(setup, hidden(setup))
    toggle(setup)
    await appears(setup, shown(setup, "Other chat"))
    expect(setup.config().session?.sidebar).toBe("hide")
  })

  test("a subagent's chat without its own follows its root chat's, and keeps its own once changed there", async () => {
    await using state = await tmpdir()
    {
      await using parent = await window({ state: state.path, sessionID: PARENT.id })
      await appears(parent, shown(parent, "Parent chat"))
      toggle(parent)
      await appears(parent, hidden(parent))
    }
    await using child = await window({ state: state.path, sessionID: CHILD.id })
    const inChild = (frame: string) => frame.includes("No active subagents")
    await appears(child, inChild)
    await child.waitForVisualIdle({ quietFrames: 2 })
    expect(sidebarText(child).includes("Subagent chat")).toBe(false)
    toggle(child)
    await appears(child, (frame) => inChild(frame) && sidebarText(child, frame).includes("Subagent chat"))
    child.mockInput.pressEscape()
    await appears(child, hidden(child))
  })
})

describe("the Todo and MCP sections of each chat", () => {
  test("folding them in one chat leaves another chat's, and they stay folded after a restart", async () => {
    await using state = await tmpdir()
    {
      await using first = await window({ state: state.path, sessionID: PARENT.id })
      await using second = await window({ state: state.path, sessionID: OTHER.id })
      await appears(first, shown(first, "Parent chat"))
      await appears(second, shown(second, "Other chat"))
      await clickSection(first, "Todo")
      await appears(first, (frame) => sidebarText(first, frame).includes("Todo (2 remaining)"))
      await clickSection(first, "MCP")
      await appears(first, (frame) => sidebarText(first, frame).includes("MCP (3 active)"))
      await settle(second)
      const text = sidebarText(second)
      expect(text).toContain("▼ Todo")
      expect(text).toContain("▼ MCP")
      expect(text).toContain("Third step")
      expect(text).toContain("gamma")
    }
    await using first = await window({ state: state.path, sessionID: PARENT.id })
    await appears(first, (frame) => {
      const text = sidebarText(first, frame)
      return text.includes("Todo (2 remaining)") && text.includes("MCP (3 active)")
    })
    await clickSection(first, "Todo")
    await appears(first, (frame) => sidebarText(first, frame).includes("Third step"))
  })
})

describe("the state of chats that no longer exist", () => {
  test("goes when the chat is deleted, and at the next start for chats deleted meanwhile", async () => {
    await using state = await tmpdir()
    {
      await using first = await window({ state: state.path, sessionID: PARENT.id })
      await using second = await window({ state: state.path, sessionID: OTHER.id })
      await appears(first, shown(first, "Parent chat"))
      await appears(second, shown(second, "Other chat"))
      toggle(first)
      toggle(second)
      await appears(first, hidden(first))
      await appears(second, hidden(second))
      await until(() => stored(state.path).length === 2, 5_000, "both stored")
      first.events.emit({
        id: "evt_deleted",
        created: 3,
        type: "session.deleted",
        durable: { aggregateID: OTHER.id, seq: 1, version: 2 },
        data: { sessionID: OTHER.id },
      })
      await until(() => !stored(state.path).includes(OTHER.id), 5_000, "deleted forgotten")
      expect(stored(state.path)).toEqual([PARENT.id])
    }
    {
      await using other = await window({ state: state.path, sessionID: OTHER.id })
      await appears(other, shown(other, "Other chat"))
      toggle(other)
      await appears(other, hidden(other))
      await until(() => stored(state.path).includes(OTHER.id), 5_000, "other stored again")
    }
    // OTHER is deleted while no TUI runs: the next start asks the service about the chats it holds state for.
    await using setup = await window({ state: state.path, sessionID: PARENT.id, gone: [OTHER.id] })
    await appears(setup, hidden(setup))
    await until(() => !stored(state.path).includes(OTHER.id), 5_000, "gone forgotten at start")
    expect(stored(state.path)).toEqual([PARENT.id])
    expect(setup.asked).toContain(OTHER.id)
  })
})
