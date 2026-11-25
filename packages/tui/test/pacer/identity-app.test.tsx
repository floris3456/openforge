import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import type { PacerIdentity, SessionMessageInfo } from "@opencode/client"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { waitForHighlightedFrame } from "../fixture/frame"
import { json } from "../fixture/tui-client"
import { until } from "../fixture/wait"
import { CHAT, chat, NOW, pacerFake, sessionInfo, status } from "./fixture"

// The owner's /identity in the whole TUI (the workspace's spec docs/specs/agent-badges.md, section 1, item 6): a slash
// command beside /rename, offered only while CLIProxyPacer keeps agents' identities, so a TUI against a CPP without
// them is as before. `/identity <session id>` links the open chat to that chat's identity, `/identity new` gives it its
// own again, and `/identity` alone opens the picker.

// A draft an earlier test left in the chat is kept in the process (draft-stash), and would be typed before these
// commands.
beforeEach(() => {
  setSystemTime(NOW)
  takeDraft(CHAT)
})
afterEach(() => setSystemTime())

const LEAD: PacerIdentity = {
  id: "k3m9x2v7p0qa",
  name: "floris's lead",
  person: "floris",
  part: "lead",
  role: "build",
  title: "Agent badges plan",
  chats: [{ chat: "ses_other", how: "made", since: NOW - 3_600_000, current: true }],
  openTasks: [],
  lastActive: NOW - 3 * 60_000,
  madeAt: NOW - 3_600_000,
}

const transcript = [
  { type: "user", id: "msg_u1", text: "First question", time: { created: NOW - 20_000 } },
  {
    type: "assistant",
    id: "msg_a1",
    agent: "build",
    model: { providerID: "cliproxypacer", id: "claude-opus-4-5" },
    time: { created: NOW - 10_000, completed: NOW - 5_000 },
    finish: "stop",
    tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text", text: "Latest reply" }],
  },
] as unknown as SessionMessageInfo[]

/** The TUI on chat `CHAT`, on CPP, whose capabilities say `identities` or not. */
async function app(identities: boolean) {
  const fake = pacerFake()
  fake.status = status("on")
  fake.features = { identities }
  fake.chats[CHAT] = chat()
  fake.identities = { items: [LEAD] }
  fake.link = (body) => ({ identity: LEAD, changed: (body as { new?: boolean }).new !== true })
  const setup = await createAppFixture({
    width: 140,
    height: 40,
    config: { animations: false },
    args: { sessionID: CHAT },
    fetch: async (url, request) => {
      const pacer = await fake.handle(url, request)
      if (pacer) return pacer
      if (url.pathname === `/api/session/${CHAT}`) return json({ data: sessionInfo(CHAT, "cliproxypacer") })
      if (url.pathname === `/api/session/${CHAT}/message`) return json({ data: transcript.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${CHAT}/inbox` || url.pathname === `/api/session/${CHAT}/permission`)
        return json({ data: [] })
    },
  })
  await setup.ready
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Latest reply"), { maxPasses: 200 })
  // The features are read once CPP's status says it is set up.
  await until(() => fake.calls.some((call) => call.path === "features"), 5_000)
  /** Types `keys` into the composer as a terminal hands them over, in one piece. */
  const read = (keys: string) => setup.renderer.stdin.emit("data", Buffer.from(keys))
  const links = () => fake.calls.filter((call) => call.path === `chat/${CHAT}/identity`).map((call) => call.body)
  return { setup, fake, read, links }
}

test("/identity <session id> and /identity new link the chat, and /identity alone opens the picker", async () => {
  const { setup, read, links } = await app(true)
  await using _ = setup
  read("/ident")
  await setup.waitForFrame((frame) => frame.includes("Link agent identity"), { maxPasses: 100 })
  read("ity ses_other\r")
  await until(() => links().length === 1, 5_000)
  expect(links()).toEqual([{ session: "ses_other" }])
  await setup.waitForFrame((frame) => frame.includes("This chat is now floris's lead (Agent badges plan)"), {
    maxPasses: 100,
  })
  read("/identity new\r")
  await until(() => links().length === 2, 5_000)
  expect(links()[1]).toEqual({ new: true })
  // As /rename: Enter on the popup's /identity puts it in the composer for an argument, and Enter again runs it.
  read("/identity\r")
  await setup.waitForFrame((frame) => frame.includes("/identity "), { maxPasses: 100 })
  read("\r")
  await setup.waitForFrame((frame) => frame.includes("Link this chat to an agent's identity"), { maxPasses: 100 })
  await setup.waitForFrame((frame) => frame.includes("floris's lead") && frame.includes("active 3 min ago"), {
    maxPasses: 100,
  })
})

test("against a CLIProxyPacer without identities there is no /identity", async () => {
  const { setup, fake, read, links } = await app(false)
  await using _ = setup
  // The popup lists /rename, beside which /identity would be.
  read("/rena")
  await setup.waitForFrame((frame) => frame.includes("Rename session"), { maxPasses: 100 })
  for (let i = 0; i < 4; i++) setup.mockInput.pressBackspace()
  read("ident")
  await setup.waitForFrame((frame) => frame.includes("/ident") && !frame.includes("Rename session"), {
    maxPasses: 100,
  })
  expect(setup.captureCharFrame()).not.toContain("Link agent identity")
  expect(links()).toEqual([])
  expect(fake.calls.some((call) => call.path.endsWith("/identities"))).toBe(false)
})
