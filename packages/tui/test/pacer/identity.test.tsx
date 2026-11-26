/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { PacerIdentity } from "@opencode/client"
import { InputRenderable } from "@opentui/core"
import { DialogIdentityList, identityTarget, lastActive, linkedMessage } from "../../src/component/dialog-identity-list"
import { useToast, type ToastContext } from "../../src/ui/toast"
import { until } from "../fixture/wait"
import { CHAT, NOW, pacerFake, renderPacer, status } from "./fixture"

// The owner's /identity picker (the workspace's spec docs/specs/agent-badges.md, section 1, item 6): built like the
// session list over the chat's project's identities, the most recently active first, each its name, title and when last
// active; typing filters on title, name or a session ID; Enter links the open chat to the one chosen, and a toast
// says "This chat is now floris's lead (Agent badges plan)".

function identity(id: string, extra: Partial<PacerIdentity> = {}): PacerIdentity {
  return {
    id,
    name: "floris's lead",
    person: "floris",
    part: "lead",
    role: "build",
    title: "Agent badges plan",
    chats: [{ chat: CHAT, how: "made", since: NOW - 3_600_000, current: true }],
    openTasks: [],
    lastActive: NOW - 3 * 60_000,
    madeAt: NOW - 3_600_000,
    ...extra,
  }
}

const LEAD = identity("k3m9x2v7p0qa")
const EXPLORER = identity("a1b2c3d4e5f6", {
  name: "floris's explore",
  part: "explore",
  role: "explore",
  title: "Read the review code",
  chats: [{ chat: "ses_explorer", how: "made", since: NOW - 7_200_000, current: true }],
  lastActive: NOW - 2 * 3_600_000,
})
const { person: _person, title: _title, lastActive: _active, ...UNKNOWN_BASE } = identity("z9y8x7w6v5u4")
const UNKNOWN: PacerIdentity = {
  ...UNKNOWN_BASE,
  name: "lead (owner unknown)",
  chats: [{ chat: "ses_old_lead", how: "made", since: NOW - 86_400_000, current: true }],
}

/** The picker over `fake`'s identities, and the toasts it shows. */
async function picker(fake: ReturnType<typeof pacerFake>) {
  let toast!: ToastContext
  function Toasts() {
    toast = useToast()
    return null
  }
  fake.status = status("on")
  fake.features = { identities: true, badges: false }
  const setup = await renderPacer({ fake, content: () => <Toasts />, width: 100, height: 30 })
  setup.dialog.replace(() => <DialogIdentityList sessionID={CHAT} now={() => NOW} />)
  return {
    setup,
    toast: () => toast.currentToast,
    /** Types `text` once the filter has the focus. */
    async type(text: string) {
      await until(() => setup.app.renderer.currentFocusedRenderable instanceof InputRenderable, 5_000)
      await setup.app.mockInput.typeText(text)
    },
  }
}

const rows = (frame: string) => frame.split("\n")

describe("the /identity picker", () => {
  test("lists the project's identities, the most recently active first, each its name, title and last activity", async () => {
    const fake = pacerFake()
    fake.identities = { items: [LEAD, EXPLORER, UNKNOWN], current: LEAD.id }
    const { setup } = await picker(fake)
    await using _ = setup
    const frame = await setup.frame((frame) => frame.includes("lead (owner unknown)"))
    const line = (text: string) => rows(frame).findIndex((row) => row.includes(text))
    expect(rows(frame)[line("floris's lead")]).toContain("Agent badges plan")
    expect(rows(frame)[line("floris's lead")]).toContain("active 3 min ago")
    expect(rows(frame)[line("floris's explore")]).toContain("Read the review code")
    expect(rows(frame)[line("floris's explore")]).toContain("active 2 h ago")
    expect(rows(frame)[line("lead (owner unknown)")]).toContain("never active")
    expect(line("floris's lead")).toBeLessThan(line("floris's explore"))
    expect(line("floris's explore")).toBeLessThan(line("lead (owner unknown)"))
    expect(fake.calls.filter((call) => call.path === `chat/${CHAT}/identities`)).toHaveLength(1)
  })

  test("filters on a title, a name or a session ID, and Enter links the chat to the one chosen", async () => {
    const fake = pacerFake()
    fake.identities = { items: [LEAD, EXPLORER, UNKNOWN], current: LEAD.id }
    fake.link = () => ({ identity: UNKNOWN, changed: true })
    const { setup, type, toast } = await picker(fake)
    await using _ = setup
    await setup.frame((frame) => frame.includes("lead (owner unknown)"))
    await type("review code")
    let frame = await setup.frame((frame) => !frame.includes("floris's lead"))
    expect(frame).toContain("floris's explore")
    expect(frame).not.toContain("lead (owner unknown)")
    for (let i = 0; i < "review code".length; i++) await setup.app.mockInput.pressBackspace()
    await type("owner unknown")
    frame = await setup.frame((frame) => !frame.includes("floris's explore"))
    expect(frame).toContain("lead (owner unknown)")
    for (let i = 0; i < "owner unknown".length; i++) await setup.app.mockInput.pressBackspace()
    await type("ses_old_lead")
    frame = await setup.frame((frame) => !frame.includes("floris's lead") && !frame.includes("floris's explore"))
    expect(frame).toContain("lead (owner unknown)")
    setup.app.mockInput.pressEnter()
    await until(() => toast() !== null, 5_000)
    expect(fake.calls.filter((call) => call.path === `chat/${CHAT}/identity`).map((call) => call.body)).toEqual([
      { identity: UNKNOWN.id },
    ])
    expect(toast()).toMatchObject({ variant: "success", message: "This chat is now lead (owner unknown)" })
    // The picker closed.
    await setup.frame((frame) => !frame.includes("Link this chat"))
  })

  test("says why it lists none: the service's refusal in words, or no identity yet", async () => {
    const refusal = "This chat's folder is not in a git repository, so it has no project, memory or task board."
    const fake = pacerFake()
    fake.identities = { refused: refusal }
    const refused = await picker(fake)
    await using _refused = refused.setup
    await refused.setup.frame((frame) => frame.replace(/\s+/g, " ").includes("not in a git repository"))
    const empty = pacerFake()
    empty.identities = { items: [] }
    const none = await picker(empty)
    await using _none = none.setup
    await none.setup.frame((frame) => frame.replace(/\s+/g, " ").includes("first board action"))
  })

  test("a link CPP refuses says why in a toast", async () => {
    const fake = pacerFake()
    fake.identities = { items: [LEAD, EXPLORER] }
    fake.link = () => "That identity is another project's: a chat takes only an identity of its own project."
    const { setup, toast } = await picker(fake)
    await using _ = setup
    await setup.frame((frame) => frame.includes("floris's explore"))
    setup.app.mockInput.pressEnter()
    await until(() => toast() !== null, 5_000)
    expect(toast()).toMatchObject({
      variant: "error",
      message:
        "Could not link this chat: That identity is another project's: a chat takes only an identity of its own project.",
    })
  })
})

describe("/identity's words", () => {
  test("the toast names the identity and its title", () => {
    expect(linkedMessage(LEAD)).toBe("This chat is now floris's lead (Agent badges plan)")
    expect(linkedMessage(UNKNOWN)).toBe("This chat is now lead (owner unknown)")
    expect(linkedMessage(LEAD, false)).toBe("This chat already is floris's lead (Agent badges plan)")
  })

  test("when last active", () => {
    expect(lastActive(undefined, NOW)).toBe("never active")
    expect(lastActive(NOW - 20_000, NOW)).toBe("active just now")
    expect(lastActive(NOW - 59 * 60_000, NOW)).toBe("active 59 min ago")
    expect(lastActive(NOW - 47 * 3_600_000, NOW)).toBe("active 47 h ago")
    expect(lastActive(NOW - 3 * 86_400_000, NOW)).toBe("active 3 d ago")
  })

  test("the argument new is the chat's own identity again; any other is a session ID", () => {
    expect(identityTarget("new")).toEqual({ new: true })
    expect(identityTarget("  new ")).toEqual({ new: true })
    expect(identityTarget(" ses_abc ")).toEqual({ session: "ses_abc" })
  })
})
