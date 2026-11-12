import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { sidebarModel } from "../src/routes/session/sidebar-model"
import { SESSION_SIDEBAR_WIDTH } from "../src/ui/layout"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

// The owner, 2026-11-12: "the sidebar doesn't stay for a subagent. I of course want to know what accounts the subagent
// is using". A subagent's chat shows the sidebar as any chat does, with that chat's own data.

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

async function app(width: number, sessionID: string) {
  const state = await tmpdir()
  const setup = await createAppFixture({
    width,
    height: 30,
    state: state.path,
    config: { animations: false, tabs: { mode: "off" } },
    args: { sessionID },
    fetch: (url) => {
      const known = [PARENT, CHILD].find((item) => url.pathname === `/api/session/${item.id}`)
      if (known) return json({ data: known })
      if (/^\/api\/session\/ses_(parent|child)\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === PARENT.id)
        return json({ data: [CHILD], cursor: {} })
      return undefined
    },
  })
  return {
    setup,
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

/** Whether the sidebar's title line, in the window's last SESSION_SIDEBAR_WIDTH columns, names the chat. */
const sidebarShows = (frame: string, width: number, title: string) =>
  frame.split("\n").some((line) => line.slice(width - SESSION_SIDEBAR_WIDTH).includes(title))

describe("the sidebar in a subagent's chat", () => {
  test("shows in a wide window with the subagent's own chat, and stays on going to the parent", async () => {
    await using fixture = await app(170, CHILD.id)
    const setup = fixture.setup
    await setup.ready
    await setup.waitForFrame((frame) => sidebarShows(frame, 170, "Subagent chat"))
    // Escape leaves a subagent's chat for its parent's.
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => sidebarShows(frame, 170, "Parent chat"))
  })

  test("in a narrow window, opens over the chat with the leader key and b; Escape closes it first, then leaves", async () => {
    await using fixture = await app(100, CHILD.id)
    const setup = fixture.setup
    await setup.ready
    // The composer, always open in a subagent's chat, at its Subagents tab.
    const inChild = (frame: string) => frame.includes("No active subagents")
    await setup.waitForFrame(inChild)
    expect(sidebarShows(setup.captureCharFrame(), 100, "Subagent chat")).toBe(false)
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.waitForFrame((frame) => sidebarShows(frame, 100, "Subagent chat"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !sidebarShows(frame, 100, "Subagent chat") && inChild(frame))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => frame.includes("ctrl+p commands") && !inChild(frame))
  })
})

describe("the model the sidebar follows", () => {
  const picked = { providerID: "anthropic", modelID: "claude-main" }
  const own = { providerID: "cliproxypacer", id: "claude-subagent" }
  const answer = (providerID: string, id: string) =>
    ({
      id: "msg_answer",
      type: "assistant",
      agent: "general",
      model: { providerID, id },
      content: [],
      time: { created: 1 },
    }) as unknown as SessionMessageInfo

  test("a chat's: the prompt's pick, also before it is sent, else its own", () => {
    expect(sidebarModel({ session: session("ses_a", { model: own }), messages: () => [], picked })).toEqual({
      providerID: "anthropic",
      id: "claude-main",
    })
    expect(sidebarModel({ session: session("ses_a", { model: own }), messages: () => [], picked: undefined })).toEqual(
      own,
    )
  })

  test("a subagent's: its own model, not the prompt's pick, which is the main agent's", () => {
    expect(sidebarModel({ session: { ...CHILD, model: own }, messages: () => [], picked })).toEqual(own)
  })

  test("a subagent's started on the default model: its last answer's", () => {
    expect(
      sidebarModel({
        session: CHILD,
        messages: () => [answer("anthropic", "older"), answer("cliproxypacer", "newer")],
        picked,
      }),
    ).toEqual({ providerID: "cliproxypacer", id: "newer" })
    expect(sidebarModel({ session: CHILD, messages: () => [], picked })).toBeUndefined()
  })
})
