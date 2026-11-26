import { expect, test } from "bun:test"
import type { PacerBadge, SessionMessageInfo } from "@opencode/client"
import { parseThemeDocument, resolveThemeDocument, rgbToOklch } from "@opencode/theme/tui"
import { RGBA } from "@opentui/core"
import { mkdir } from "node:fs/promises"
import nord from "../../src/theme/assets/nord.json"
import { allThemes, parseTheme } from "../../src/theme"
import { agentHue, agentSettings, agentTheme } from "../../src/theme/agent"
import { SESSION_SIDEBAR_WIDTH } from "../../src/ui/layout"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { waitForHighlightedFrame } from "../fixture/frame"
import { directory, json } from "../fixture/tui-client"
import { until } from "../fixture/wait"
import { pacerFake, status } from "./fixture"

// Agents' colours in the terminal (the workspace's spec docs/specs/agent-badges.md, section 3, item 3): where a chat's
// title shows (the session tabs, the session list, the sidebar's title, the subagents tab, a subagent's row in the
// chat), a chat with an identity has its title in its badge scheme's background colour, lightened or darkened until it
// reaches 4.5:1 against what it is drawn on. Only while CLIProxyPacer says `memory.badges`; a chat without an identity
// keeps its title's colour. The agent theme takes the root chat's scheme hue from the same badges.

function session(id: string, title: string, extra: { parentID?: string; agent?: string } = {}) {
  return {
    id,
    title,
    projectID: "proj_badges",
    agent: extra.agent ?? "build",
    model: { providerID: "cliproxypacer", id: "claude-opus-4-5" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    ...(extra.parentID ? { parentID: extra.parentID } : {}),
  }
}

// Two families: Alpha's lead and its subagent in shades of one hue, Beta's lead in another; Gamma has no identity.
const ALPHA = session("ses_badge_alpha", "Alpha plan")
const SUB = session("ses_badge_alpha_sub", "Alpha subagent", { parentID: ALPHA.id, agent: "general" })
const BETA = session("ses_badge_beta", "Beta plan")
const GAMMA = session("ses_badge_gamma", "Gamma chat")
const sessions = [ALPHA, SUB, BETA, GAMMA]

/**
 * Production's schemes (CPP 236985ae): a lead's (L 0.42), dark enough to need lightening on a dark theme; a pale shade
 * of it (L 0.88), darkened on a light one; and a mid one (L 0.66) of another hue.
 */
const BADGES: Record<string, PacerBadge | null> = {
  [ALPHA.id]: { background: "#00537c", hue: 240 },
  [SUB.id]: { background: "#bde4ff", hue: 240 },
  [BETA.id]: { background: "#da6a76", hue: 15 },
  [GAMMA.id]: null,
}
const NONE = Object.fromEntries(sessions.map((item) => [item.id, null]))

const transcript = [
  { type: "user", id: "msg_u1", text: "Alpha transcript line", time: { created: 1 } },
  {
    type: "assistant",
    id: "msg_a1",
    agent: "build",
    model: { providerID: "cliproxypacer", id: "claude-opus-4-5" },
    time: { created: 2, completed: 3 },
    finish: "stop",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [
      {
        type: "tool",
        id: "call_sub",
        name: "subagent",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: { description: "Alpha subagent", agent: "general" },
          content: [],
          metadata: { sessionID: SUB.id },
        },
      },
    ],
  },
] as unknown as SessionMessageInfo[]

/** A custom theme of the themes folder without the colours a theme may leave out, on a lighter, bluer background. */
const { selectedListItemText: _selected, backgroundMenu: _menu, ...nordColours } = nord.theme as Record<string, unknown>
const MINE = { defs: nord.defs, theme: { ...nordColours, background: { dark: "#3a4150", light: "nord6" } } }

const WIDTH = 200

async function app(input: {
  badges: Record<string, PacerBadge | null>
  offered?: boolean
  layout?: "vertical" | "horizontal"
  theme?: { name: string; mode: "dark" | "light" }
  route?: string
  /** The sidebar hidden, as the agent theme's tests read the screen's colour off its last row. */
  sidebar?: "hide"
}) {
  const fake = pacerFake()
  fake.status = status("on")
  fake.features = { identities: true, badges: input.offered ?? true }
  fake.badges = input.badges
  const state = await tmpdir()
  await mkdir(`${state.path}/test/tui`, { recursive: true })
  await mkdir(`${state.path}/test/locks`, { recursive: true })
  await Bun.write(
    `${state.path}/test/tui/tabs.json`,
    JSON.stringify({
      global: { tabs: [ALPHA, BETA, GAMMA].map((item) => ({ sessionID: item.id, title: item.title })), unread: {} },
      cwd: {},
    }),
  )
  const location = { directory, project: { id: "proj_badges", directory, canonical: directory } }
  const setup = await createAppFixture({
    width: WIDTH,
    height: 40,
    state: state.path,
    themes: { Mine: MINE },
    config: {
      animations: false,
      tabs: { mode: "on", scope: "global", layout: input.layout ?? "vertical" },
      keybinds: { "session.list": "ctrl+l" },
      theme: input.theme ?? { name: "opencode", mode: "dark" },
      ...(input.sidebar ? { session: { sidebar: input.sidebar } } : {}),
    },
    args: { sessionID: input.route ?? ALPHA.id },
    fetch: async (url, request) => {
      const pacer = await fake.handle(url, request)
      if (pacer) return pacer
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") {
        const parent = url.searchParams.get("parentID")
        const children = sessions.filter((item) => item.parentID === parent)
        return json({ data: children.length ? children : sessions, cursor: {} })
      }
      const match = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname)
      const found = sessions.find((item) => item.id === match?.[1])
      if (!match || !found) return undefined
      if (!match[2]) return json({ data: found })
      if (match[2] === "/message")
        return json({
          data: found.id === ALPHA.id ? transcript.toReversed() : [],
          cursor: {},
        })
      if (match[2] === "/children") return json({ data: sessions.filter((item) => item.parentID === found.id) })
      return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  await waitForHighlightedFrame(setup, (frame) => frame.includes(input.route === GAMMA.id ? "Gamma" : "Subagent"), {
    maxPasses: 200,
  })
  // The features are read once CPP's status says it is set up.
  await until(() => fake.calls.some((call) => call.path === "features"), 5_000)
  const dispose = setup[Symbol.asyncDispose]
  return Object.assign(setup, {
    fake,
    asked: () => fake.calls.filter((call) => call.path === "badges"),
    async [Symbol.asyncDispose]() {
      await dispose()
      await state[Symbol.asyncDispose]()
    },
  })
}

type Setup = Awaited<ReturnType<typeof app>>
type Span = { text: string; fg: RGBA; bg: RGBA; x: number; y: number; line: string }

function spans(setup: Setup): Span[] {
  return setup.captureSpans().lines.flatMap((line, y) => {
    const text = line.spans.map((span) => span.text).join("")
    let x = 0
    return line.spans.map((span) => {
      const at = x
      x += span.width
      return { text: span.text, fg: span.fg, bg: span.bg, x: at, y, line: text }
    })
  })
}

const left = (span: Span) => span.x < SESSION_SIDEBAR_WIDTH
const right = (span: Span) => span.x >= WIDTH - SESSION_SIDEBAR_WIDTH
const middle = (span: Span) => !left(span) && !right(span)

/** The span showing `title` in a place: one whose text holds it, where `where` says, its line holding `line`. */
function at(setup: Setup, title: string, where: (span: Span) => boolean, line = title) {
  return spans(setup).find((span) => span.text.includes(title) && span.line.includes(line) && where(span))
}

/** Each place of 3.3 that shows on the chat's screen with the composer closed. */
function screenPlaces(setup: Setup, layout: "vertical" | "horizontal" = "vertical") {
  const tab = layout === "vertical" ? left : (span: Span) => span.y <= 1
  return {
    tabAlpha: at(setup, "Alpha plan", tab),
    tabBeta: at(setup, "Beta plan", tab),
    tabGamma: at(setup, "Gamma chat", tab),
    sidebar: at(setup, "Alpha plan", right),
    row: at(setup, "Alpha subagent", middle, "General Subagent"),
  }
}

/** The subagents tab, opened under the chat with its inactive subagents shown: its subagent's row, and how to close it. */
async function subagentsTab(setup: Setup) {
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"), { maxPasses: 100 })
  setup.mockInput.pressKey("a", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("General: Alpha subagent"), { maxPasses: 100 })
  return {
    place: () => at(setup, "Alpha subagent", middle, "General: Alpha subagent"),
    async close() {
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("General: Alpha subagent"), { maxPasses: 100 })
    },
  }
}

/** The session list's rows, the list opened over the chat. */
async function listPlaces(setup: Setup) {
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Gamma chat") && frame.includes("Sessions"), { maxPasses: 100 })
  return () => ({
    listAlpha: at(setup, "Alpha plan", middle),
    listBeta: at(setup, "Beta plan", middle),
    listGamma: at(setup, "Gamma chat", middle),
  })
}

/** WCAG 2's contrast ratio of two colours. */
function contrast(one: RGBA, two: RGBA) {
  const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = (color: RGBA) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

const hue = (color: RGBA) => rgbToOklch(color.r, color.g, color.b).h
const near = (one: number, two: number) => Math.abs(((one - two + 540) % 360) - 180) <= 20

/** That `span` shows `chat`'s title in its scheme's colour, readable on what it is drawn on. */
function inColour(span: Span | undefined, chat: string) {
  expect(span).toBeDefined()
  const badge = BADGES[chat]!
  expect({ chat, near: near(hue(span!.fg), hue(RGBA.fromHex(badge.background))) }).toEqual({ chat, near: true })
  expect(contrast(span!.fg, span!.bg)).toBeGreaterThanOrEqual(4.5)
}

const colours = (places: Record<string, Span | undefined>) =>
  Object.fromEntries(Object.entries(places).map(([name, span]) => [name, span?.fg.toInts()]))

test("without memory.badges no badge is asked for, and a chat without an identity is drawn as without badges", async () => {
  const plain = await (async () => {
    await using setup = await app({ badges: BADGES, offered: false })
    await Bun.sleep(100)
    const places = screenPlaces(setup)
    const tab = await subagentsTab(setup)
    const row = tab.place()
    await tab.close()
    const list = await listPlaces(setup)
    await setup.renderOnce()
    expect(setup.asked()).toEqual([])
    return colours({ ...places, tab: row, ...list() })
  })()
  // Every place was found.
  expect(Object.values(plain).every((value) => value !== undefined)).toBeTrue()

  await using setup = await app({ badges: NONE })
  await until(() => setup.asked().length > 0, 5_000)
  await Bun.sleep(100)
  const places = screenPlaces(setup)
  const tab = await subagentsTab(setup)
  const row = tab.place()
  await tab.close()
  const list = await listPlaces(setup)
  await setup.renderOnce()
  expect(colours({ ...places, tab: row, ...list() })).toEqual(plain)
})

test.each([
  ["the built-in dark theme", { name: "opencode", mode: "dark" as const }],
  ["the built-in light theme", { name: "opencode", mode: "light" as const }],
  ["a custom theme's fallback", { name: "Mine", mode: "dark" as const }],
])("each place of 3.3 shows a chat with an identity in its scheme's colour at 4.5:1 on %s", async (_, theme) => {
  await using setup = await app({ badges: BADGES, theme })
  // The custom theme is the one drawn: its own background, the rest of its surfaces from the fallback.
  if (theme.name === "Mine")
    await setup.waitForFrame(() => spans(setup).some((span) => span.bg.equals(RGBA.fromHex("#3a4150"))))
  await setup.waitForFrame(
    () => {
      const places = screenPlaces(setup)
      return places.tabAlpha !== undefined && near(hue(places.tabAlpha.fg), 240)
    },
    { maxPasses: 100 },
  )
  const places = screenPlaces(setup)
  inColour(places.tabAlpha, ALPHA.id)
  inColour(places.tabBeta, BETA.id)
  inColour(places.sidebar, ALPHA.id)
  inColour(places.row, SUB.id)
  const tab = await subagentsTab(setup)
  await setup.waitForFrame(() => tab.place() !== undefined && near(hue(tab.place()!.fg), 240), { maxPasses: 100 })
  inColour(tab.place(), SUB.id)
  await tab.close()
  const list = await listPlaces(setup)
  await setup.waitForFrame(() => list().listAlpha !== undefined && near(hue(list().listAlpha!.fg), 240), {
    maxPasses: 100,
  })
  inColour(list().listAlpha, ALPHA.id)
  inColour(list().listBeta, BETA.id)
})

test("a chat without an identity keeps the colour it has without badges, beside chats in their colours", async () => {
  const plain = await (async () => {
    await using setup = await app({ badges: BADGES, offered: false })
    await Bun.sleep(100)
    const list = await listPlaces(setup)
    await setup.renderOnce()
    return { ...colours(screenPlaces(setup)), ...colours(list()) }
  })()
  await using setup = await app({ badges: BADGES })
  await setup.waitForFrame(
    () => {
      const places = screenPlaces(setup)
      return places.tabAlpha !== undefined && near(hue(places.tabAlpha.fg), 240)
    },
    { maxPasses: 100 },
  )
  const places = colours(screenPlaces(setup))
  const list = await listPlaces(setup)
  await setup.waitForFrame(() => list().listAlpha !== undefined && near(hue(list().listAlpha!.fg), 240), {
    maxPasses: 100,
  })
  const shown = { ...places, ...colours(list()) }
  expect([shown.tabGamma, shown.listGamma]).toEqual([plain.tabGamma, plain.listGamma])
  for (const name of ["tabAlpha", "tabBeta", "sidebar", "row", "listAlpha", "listBeta"] as const)
    expect({ name, same: shown[name]!.join() === plain[name]!.join() }).toEqual({ name, same: false })
})

test("the horizontal tab strip shows each chat with an identity in its colour", async () => {
  await using setup = await app({ badges: BADGES, layout: "horizontal" })
  await setup.waitForFrame(
    () => {
      const places = screenPlaces(setup, "horizontal")
      return places.tabBeta !== undefined && near(hue(places.tabBeta.fg), 15)
    },
    { maxPasses: 100 },
  )
  const places = screenPlaces(setup, "horizontal")
  inColour(places.tabAlpha, ALPHA.id)
  inColour(places.tabBeta, BETA.id)
})

/** The screen's background under the agent theme with its default settings, for the hue given. */
function agentBackground(hue: number) {
  const settings = agentSettings({})
  const document = agentTheme(parseTheme(allThemes()[settings.base]!, settings.base), hue, settings)
  return resolveThemeDocument(parseThemeDocument(document, "agent"), "dark").background.base
}

/** The background of the frame's last row, which no component paints over. */
function screen(setup: Setup) {
  const lines = setup.captureSpans().lines
  return lines[lines.length - 1]!.spans.at(-1)!.bg
}

test("the agent theme takes the root chat's scheme hue, and the hash of its id for a chat without an identity", async () => {
  expect(agentHue(ALPHA.id)).not.toBe(240)
  await using setup = await app({ badges: BADGES, theme: { name: "agent", mode: "dark" }, sidebar: "hide" })
  await setup.waitForFrame(() => screen(setup).equals(agentBackground(240)), { maxPasses: 100 })
  // Gamma, the third tab, has no identity.
  setup.mockInput.pressKey("3", { ctrl: true })
  await setup.waitForFrame(() => screen(setup).equals(agentBackground(agentHue(GAMMA.id))), { maxPasses: 100 })
})

test("without memory.badges the agent theme keeps the hash of the chat's id", async () => {
  await using setup = await app({
    badges: BADGES,
    offered: false,
    theme: { name: "agent", mode: "dark" },
    sidebar: "hide",
  })
  await setup.waitForFrame(() => screen(setup).equals(agentBackground(agentHue(ALPHA.id))))
  await Bun.sleep(100)
  await setup.renderOnce()
  expect(screen(setup).equals(agentBackground(agentHue(ALPHA.id)))).toBeTrue()
  expect(setup.asked()).toEqual([])
})
