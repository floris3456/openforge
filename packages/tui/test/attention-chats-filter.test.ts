import { describe, expect, test } from "bun:test"
import type { AttentionNotifyOptions } from "@opencode/plugin/tui/context"
import { createChatFilter } from "../src/attention-chats"

// openforge (notifications step 2, fixes 1 and 2): which requests a TUI raises.

const parents: Record<string, string | undefined> = {
  ses_shown: undefined,
  ses_tab: undefined,
  ses_child: "ses_shown",
  ses_grand: "ses_child",
  ses_tabchild: "ses_tab",
  ses_other: undefined,
}

function setup(options: { open?: string[]; autoReplied?: string[]; loaded?: string[] } = {}) {
  const loaded = new Set(options.loaded ?? Object.keys(parents))
  const synced: string[] = []
  const filter = createChatFilter({
    session: {
      get: (id) => (loaded.has(id) && id in parents ? { parentID: parents[id] } : undefined),
      sync: async (id) => {
        synced.push(id)
        if (!(id in parents)) throw new Error("not found")
        loaded.add(id)
      },
    },
    open: () => options.open ?? ["ses_shown", "ses_tab"],
    autoReplied: (id) => (options.autoReplied ?? []).includes(id),
  })
  return { filter, synced }
}

const done = (sessionID?: string): AttentionNotifyOptions => ({
  message: "Session done",
  sound: { name: "done" },
  sessionID,
})
const permission = (sessionID: string): AttentionNotifyOptions => ({
  message: "Permission needs input",
  sound: { name: "permission", when: "always" },
  sessionID,
})

describe("own chats", () => {
  test("the chats in its tabs and the one it shows, with their subagents at any depth, raise", async () => {
    const tui = setup()
    for (const id of ["ses_shown", "ses_tab", "ses_child", "ses_grand", "ses_tabchild"])
      expect(await tui.filter(done(id))).toBeUndefined()
  })

  test("a chat open in no tab raises nothing, nor do its subagents", async () => {
    const tui = setup({ open: ["ses_tab"] })
    expect(await tui.filter(done("ses_other"))).toBe("session_not_open")
    expect(await tui.filter(done("ses_grand"))).toBe("session_not_open")
  })

  test("a TUI with no chat open raises no chat's events", async () => {
    expect(await setup({ open: [] }).filter(done("ses_shown"))).toBe("session_not_open")
  })

  test("a request about no chat, or a form no chat asked for, passes as before", async () => {
    const tui = setup({ open: [] })
    expect(await tui.filter(done())).toBeUndefined()
    expect(await tui.filter(done("global"))).toBeUndefined()
  })

  test("a subagent the TUI has not loaded yet is looked up, up to its chat", async () => {
    const tui = setup({ loaded: ["ses_shown"] })
    expect(await tui.filter(done("ses_grand"))).toBeUndefined()
    expect(tui.synced).toEqual(["ses_grand", "ses_child"])
  })

  test("a session that cannot be looked up is a chat of its own, and not an open one", async () => {
    expect(await setup().filter(done("ses_gone"))).toBe("session_not_open")
  })
})

describe("permissions", () => {
  test("a permission the TUI accepts itself raises nothing; its other events still raise", async () => {
    const tui = setup({ autoReplied: ["ses_shown", "ses_child"] })
    expect(await tui.filter(permission("ses_child"))).toBe("permission_answered")
    expect(await tui.filter(done("ses_child"))).toBeUndefined()
  })

  test("a permission of a chat the TUI doesn't accept for (another tab) waits for you, so it raises", async () => {
    const tui = setup({ autoReplied: ["ses_shown", "ses_child"] })
    expect(await tui.filter(permission("ses_tab"))).toBeUndefined()
    expect(await tui.filter(permission("ses_tabchild"))).toBeUndefined()
  })

  test("without autoaccept every permission of its own chats raises", async () => {
    expect(await setup().filter(permission("ses_grand"))).toBeUndefined()
  })
})
