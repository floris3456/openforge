import { beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { InputRenderable, RGBA } from "@opentui/core"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import { mkdir } from "node:fs/promises"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"
import { allThemes, parseTheme } from "../src/theme"
import { agentHue, agentSettings, agentTheme } from "../src/theme/agent"
import type { Config } from "../src/config"

// openforge (spec agent-theme): with the agent theme each chat shows in its agent's colour, switching with the tab in
// the same frame; the theme list offers it first, and Settings › Agent colours sets which parts follow.

// The home screen's draft is kept in the process across apps; one an earlier test file left would be typed before
// the commands here.
beforeEach(() => takeDraft(undefined))

function session(id: string, title: string, projectID: string, parentID?: string) {
  return {
    id,
    title,
    projectID,
    ...(parentID ? { parentID } : {}),
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

// Their hues are half the wheel apart.
const alpha = session("ses_alpha", "Alpha chat", "proj_a")
const beta = session("ses_beta", "Beta chat", "proj_a")
const child = session("ses_alpha_child", "Alpha subagent", "proj_a", alpha.id)
const sessions = [alpha, beta, child]
const content: Record<string, string> = {
  [alpha.id]: "Alpha transcript line",
  [beta.id]: "Beta transcript line",
  [child.id]: "Child transcript line",
}

/** The screen's background for a chat under the agent theme with its default settings. */
function colour(chat: string, settings: Config.AgentTheme = {}) {
  const resolved = agentSettings(settings)
  const document = agentTheme(parseTheme(allThemes()[resolved.base]!, resolved.base), agentHue(chat), resolved)
  return resolveThemeDocument(parseThemeDocument(document, "agent"), "dark")
}

async function app(input: { width: number; config: Config.Info; sessionID?: string }) {
  const state = await tmpdir()
  await mkdir(`${state.path}/test/tui`, { recursive: true })
  await mkdir(`${state.path}/test/locks`, { recursive: true })
  await Bun.write(
    `${state.path}/test/tui/tabs.json`,
    JSON.stringify({
      global: {
        tabs: [
          { sessionID: alpha.id, title: alpha.title },
          { sessionID: beta.id, title: beta.title },
        ],
        unread: {},
      },
      cwd: {},
    }),
  )
  const location = { directory, project: { id: "proj_a", directory, canonical: directory } }
  const setup = await createAppFixture({
    width: input.width,
    height: 24,
    state: state.path,
    config: {
      animations: false,
      tabs: { mode: "on", scope: "global" },
      session: { sidebar: "hide" },
      ...input.config,
    },
    args: input.sessionID ? { sessionID: input.sessionID } : {},
    fetch: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
      const match = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname)
      const found = sessions.find((item) => item.id === match?.[1])
      if (!match || !found) return undefined
      if (!match[2]) return json({ data: found })
      if (match[2] === "/message")
        return json({
          data: [{ type: "user", id: `msg_${found.id}`, text: content[found.id], time: { created: 0 } }],
          cursor: {},
        })
      if (match[2] === "/children") return json({ data: found.id === alpha.id ? [child] : [], cursor: {} })
      return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  const dispose = setup[Symbol.asyncDispose]
  return Object.assign(setup, {
    async [Symbol.asyncDispose]() {
      await dispose()
      await state[Symbol.asyncDispose]()
    },
  })
}

type Setup = Awaited<ReturnType<typeof app>>

/** The background of the frame's last row, which no component paints over. */
function screen(setup: Setup) {
  const lines = setup.captureSpans().lines
  return lines[lines.length - 1]!.spans.at(-1)!.bg
}

/** While a dialog is open the screen is dimmed under it: the theme shows in the dialog's own background. */
function dialog(setup: Setup, title: string) {
  const lines = setup.captureSpans().lines
  const header = lines.find((line) => line.spans.some((span) => span.text.includes(title)))
  return header?.spans.find((span) => span.text.includes("esc"))?.bg
}

async function command(setup: Setup, text: string, title: string) {
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.renderer.stdin.emit("data", Buffer.from(`${text}\r`))
  await setup.waitForFrame(
    (frame) => frame.includes(title) && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
}

test.each([100, 50])("each tab shows its chat's agent colour from the first frame of a switch at width %s", async (width) => {
  await using setup = await app({ width, sessionID: alpha.id, config: { theme: { name: "agent", mode: "dark" } } })
  const one = colour(alpha.id).background.base
  const two = colour(beta.id).background.base
  expect(one.equals(two)).toBeFalse()
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  await setup.waitForFrame(() => screen(setup).equals(one))

  // Every frame until the other tab settles shows either chat in its own colour, never one in the other's.
  const check = (frame: string) => {
    const color: RGBA = screen(setup)
    if (frame.includes(content[alpha.id]!)) expect(color.equals(one)).toBeTrue()
    if (frame.includes(content[beta.id]!)) expect(color.equals(two)).toBeTrue()
    expect(color.equals(one) || color.equals(two)).toBeTrue()
  }
  setup.mockInput.pressKey("2", { ctrl: true })
  await waitForHighlightedFrame(setup, (frame) => {
    check(frame)
    return frame.includes(content[beta.id]!)
  })
  expect(screen(setup).equals(two)).toBeTrue()

  setup.mockInput.pressKey("1", { ctrl: true })
  await waitForHighlightedFrame(setup, (frame) => {
    check(frame)
    return frame.includes(content[alpha.id]!)
  })
  expect(screen(setup).equals(one)).toBeTrue()
  expect(setup.config().theme).toEqual({ name: "agent", mode: "dark" })
})

test("a subagent's chat shows its root chat's agent colour", async () => {
  await using setup = await app({
    width: 100,
    sessionID: child.id,
    config: { tabs: { mode: "off" }, theme: { name: "agent", mode: "dark" } },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[child.id]!))
  await setup.waitForFrame(() => screen(setup).equals(colour(alpha.id).background.base))
})

test("the theme list offers Agent colours first; picking it in a project turns it on for that project", async () => {
  await using setup = await app({
    width: 100,
    sessionID: alpha.id,
    config: { tabs: { mode: "off" }, theme: { name: "dracula", mode: "dark" } },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  await command(setup, "/themes", "Themes")
  const lines = setup.captureCharFrame().split("\n")
  const global = lines.findIndex((line) => line.includes("Global theme (dracula)"))
  expect(lines[global + 1]).toContain("Agent colours")
  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(setup.config().projects).toBeUndefined()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Themes"))
  await setup.waitFor(() => setup.config().projects?.proj_a?.theme?.name === "agent")
  await setup.waitForFrame(() => screen(setup).equals(colour(alpha.id).background.base))
  expect(setup.config().theme).toEqual({ name: "dracula", mode: "dark" })
})

test.each([100, 50])("Settings › Agent colours: Enter on a part makes it follow, and Use turns it on, at width %s", async (width) => {
  await using setup = await app({
    width,
    sessionID: alpha.id,
    config: { tabs: { mode: "off" }, theme: { name: "nord", mode: "dark" } },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  await command(setup, "/settings", "Settings")
  await setup.mockInput.typeText("agent colours")
  await setup.waitForFrame((frame) => frame.includes("Agent colours") && frame.includes("off"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Takes the agent's colour") &&
      setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  // Open, it shows the agent theme in this chat's colour, written nowhere yet.
  await setup.waitForFrame(
    () => dialog(setup, "Agent colours")?.equals(colour(alpha.id).surface("dialog").background.base) === true,
  )
  expect(setup.config().theme).toEqual({ name: "nord", mode: "dark" })

  await setup.mockInput.typeText("borders")
  await setup.waitForFrame((frame) => frame.includes("Borders"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.config().theme?.agent?.follow?.includes("borders") === true)
  expect(setup.config().theme?.agent).toEqual({ base: "opencode", follow: ["background", "panels", "borders"], strength: "clear" })
  expect(setup.config().theme?.name).toBe("nord")

  for (const _ of "borders") setup.mockInput.pressBackspace()
  await setup.mockInput.typeText("use agent")
  await setup.waitForFrame((frame) => frame.includes("Use agent colours"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.config().projects?.proj_a?.theme?.name === "agent")
})
