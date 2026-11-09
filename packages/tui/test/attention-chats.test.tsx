import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import type { Attention } from "@opencode/schema/attention"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// openforge (notifications step 2, fixes 1 and 2): a TUI raises only the events of its own chats, and no permission
// that it accepts itself. The whole TUI runs against a fixture service, which records what the TUI reports.

const session = (id: string, parentID?: string) => ({
  id,
  title: `Chat ${id}`,
  ...(parentID && { parentID }),
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
})

// ses_open is the chat this TUI shows; ses_child its subagent, ses_grand the subagent's; ses_other is open in no TUI.
const sessions = {
  ses_open: session("ses_open"),
  ses_child: session("ses_child", "ses_open"),
  ses_grand: session("ses_grand", "ses_child"),
  ses_other: session("ses_other"),
}
type Chat = keyof typeof sessions

async function setup(permissions: "prompt" | "autoaccept") {
  const reported: Attention.Occurrence[] = []
  const replies: string[] = []
  const served = new Set<string>()
  const changed = Promise.withResolvers<void>()
  let wake = changed
  const fixture = await createAppFixture({
    config: {
      animations: false,
      tabs: { mode: "off" },
      session: { sidebar: "hide", permissions },
      attention: { notifications: true, sound: true },
    } as Config.Info,
    args: { sessionID: "ses_open" },
    fetch: async (url, request) => {
      served.add(url.pathname)
      const notify = () => {
        wake.resolve()
        wake = Promise.withResolvers<void>()
      }
      if (url.pathname === "/api/experimental/attention/occurrence") {
        reported.push((await request.json()) as Attention.Occurrence)
        notify()
        // A --desktop player follows, so the TUI itself plays and shows nothing.
        return json({ data: { sound: true, desktop: true } })
      }
      const reply = url.pathname.match(/^\/api\/session\/(ses_\w+)\/permission\/(\w+)\/reply$/)
      if (reply) {
        replies.push(`${reply[1]}/${reply[2]}`)
        notify()
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_open")
        return json({ data: [sessions.ses_child], cursor: {} })
      if (url.pathname === "/api/session" && url.searchParams.has("parentID")) return json({ data: [], cursor: {} })
      const info = url.pathname.match(/^\/api\/session\/(ses_\w+)$/)?.[1]
      if (info && info in sessions) {
        notify()
        return json({ data: sessions[info as Chat] })
      }
      if (/^\/api\/session\/ses_\w+\/(permission|form|inbox)$/.test(url.pathname)) {
        notify()
        return json({ data: [] })
      }
      if (/^\/api\/session\/ses_\w+\/message$/.test(url.pathname)) return json({ data: [], cursor: {} })
      return undefined
    },
  })
  await fixture.ready
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out")
      await Promise.race([wake.promise, Bun.sleep(50)])
    }
  }
  // The route has loaded the chat it shows and its subagent's permissions.
  await until(() => served.has("/api/session/ses_open") && served.has("/api/session/ses_child/permission"))
  let seq = 0
  const durable = (sessionID: string) => ({ aggregateID: sessionID, seq: ++seq, version: 1 as const })
  return {
    fixture,
    reported,
    replies,
    served,
    until,
    done(sessionID: Chat) {
      fixture.events.emit({
        id: `evt_done_${++seq}`,
        created: seq,
        type: "session.execution.succeeded",
        durable: durable(sessionID),
        data: { sessionID },
      } as OpenCodeEvent)
    },
    created(sessionID: Chat) {
      const info = sessions[sessionID]
      fixture.events.emit({
        id: `evt_created_${sessionID}`,
        created: ++seq,
        type: "session.created",
        durable: durable(sessionID),
        data: { ...info, sessionID, slug: sessionID, version: "test" },
      } as OpenCodeEvent)
    },
    ask(sessionID: Chat, id: string) {
      fixture.events.emit({
        id: `evt_ask_${id}`,
        created: ++seq,
        type: "permission.asked",
        data: { id, sessionID, action: "shell", resources: [], metadata: {}, save: [] },
      } as OpenCodeEvent)
    },
    kinds: () => reported.map((occurrence) => `${occurrence.kind}:${occurrence.sessionID}`),
  }
}

test("a TUI raises only its own chats' events, its subagents' at any depth included", async () => {
  const tui = await setup("prompt")
  await using _ = tui.fixture
  // The subagent's subagent starts while the TUI runs, so the TUI knows it as a subagent.
  tui.created("ses_grand")
  await tui.until(() => tui.served.has("/api/session/ses_grand"))
  tui.done("ses_other")
  tui.done("ses_grand")
  tui.done("ses_open")
  await tui.until(() => tui.kinds().includes("done:ses_open") && tui.reported.some((item) => item.sessionID === "ses_grand"))
  expect(tui.kinds().toSorted()).toEqual(["done:ses_open", "subagent_done:ses_grand"])
})

test("with autoaccept, a permission the TUI accepts itself raises nothing; one that waits for you raises one", async () => {
  const tui = await setup("autoaccept")
  await using _ = tui.fixture
  tui.ask("ses_child", "per_auto")
  await tui.until(() => tui.replies.length >= 1)
  expect(tui.replies).toEqual(["ses_child/per_auto"])
  tui.done("ses_open")
  await tui.until(() => tui.reported.length >= 1)
  expect(tui.kinds()).toEqual(["done:ses_open"])
})

test("in prompt mode every permission of its own chats raises one occurrence", async () => {
  const tui = await setup("prompt")
  await using _ = tui.fixture
  tui.ask("ses_child", "per_one")
  await tui.until(() => tui.reported.length >= 1)
  tui.ask("ses_open", "per_two")
  await tui.until(() => tui.reported.length >= 2)
  expect(tui.kinds()).toEqual(["permission:ses_child", "permission:ses_open"])
  expect(tui.replies).toEqual([])
})
