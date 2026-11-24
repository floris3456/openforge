import { beforeEach, expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { InputRenderable, RGBA } from "@opentui/core"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { mkdir } from "node:fs/promises"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"
import { allThemes, parseTheme } from "../src/theme"
import type { Config } from "../src/config"

// openforge (spec project-themes): the screen shows the shown project's theme, switching with the tab in the same frame;
// the picker previews without writing and writes the project's theme, or removes it, on Enter.

// The home screen's draft is kept in the process across apps; one an earlier test file left would be typed before
// the commands here.
beforeEach(() => takeDraft(undefined))

const background = (name: string) =>
  resolveThemeDocument(parseTheme(allThemes()[name]!, name), "dark").background.base

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

const alpha = session("ses_alpha", "Alpha chat", "proj_a")
const beta = session("ses_beta", "Beta chat", "proj_b")
const child = session("ses_alpha_child", "Alpha subagent", "proj_elsewhere", alpha.id)
const sessions = [alpha, beta, child]
const content: Record<string, string> = {
  [alpha.id]: "Alpha transcript line",
  [beta.id]: "Beta transcript line",
  [child.id]: "Child transcript line",
}

async function app(input: { width: number; config: Config.Info; sessionID?: string; project?: string }) {
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
  const location = { directory, project: { id: input.project ?? "proj_home", directory, canonical: directory } }
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

function same(color: RGBA, name: string) {
  return color.equals(background(name))
}

/** While a dialog is open the screen is dimmed under it: the theme shows in the dialog's own background. */
function dialog(setup: Setup) {
  const lines = setup.captureSpans().lines
  const header = lines.find((line) => line.spans.some((span) => span.text.includes("Themes")))
  return header?.spans.find((span) => span.text.includes("esc"))?.bg
}

function previews(setup: Setup, name: string) {
  const color = dialog(setup)
  return (
    color !== undefined &&
    color.equals(resolveThemeDocument(parseTheme(allThemes()[name]!, name), "dark").surface("dialog").background.base)
  )
}

async function openThemes(setup: Setup) {
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.renderer.stdin.emit("data", Buffer.from("/themes\r"))
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Themes") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
}

test.each([100, 50])("each tab shows its project's theme from the first frame of a switch at width %s", async (width) => {
  await using setup = await app({
    width,
    sessionID: alpha.id,
    config: { theme: { name: "dracula", mode: "dark" }, projects: { proj_a: { theme: { name: "nord" } } } },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  expect(same(screen(setup), "nord")).toBeTrue()

  // Every frame until the other tab settles shows either tab in its own theme, never one in the other's.
  const check = (frame: string) => {
    const color = screen(setup)
    if (frame.includes(content[alpha.id]!)) expect(same(color, "nord")).toBeTrue()
    if (frame.includes(content[beta.id]!)) expect(same(color, "dracula")).toBeTrue()
    expect(same(color, "nord") || same(color, "dracula")).toBeTrue()
  }
  setup.mockInput.pressKey("2", { ctrl: true })
  await waitForHighlightedFrame(setup, (frame) => {
    check(frame)
    return frame.includes(content[beta.id]!)
  })
  expect(same(screen(setup), "dracula")).toBeTrue()

  setup.mockInput.pressKey("1", { ctrl: true })
  await waitForHighlightedFrame(setup, (frame) => {
    check(frame)
    return frame.includes(content[alpha.id]!)
  })
  expect(same(screen(setup), "nord")).toBeTrue()
  expect(setup.config().projects).toEqual({ proj_a: { theme: { name: "nord" } } })
})

test("a subagent's chat shows its root chat's project theme, as its tab does", async () => {
  await using setup = await app({
    width: 100,
    sessionID: child.id,
    config: {
      tabs: { mode: "off" },
      theme: { name: "dracula", mode: "dark" },
      projects: { proj_a: { theme: { name: "nord" } }, proj_elsewhere: { theme: { name: "gruvbox" } } },
    },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[child.id]!))
  await setup.waitForFrame(() => same(screen(setup), "nord"))
})

test("in a project the picker previews without writing, Enter sets the project's theme and the global row removes it", async () => {
  await using setup = await app({
    width: 100,
    sessionID: alpha.id,
    config: { theme: { name: "dracula", mode: "dark" } },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  expect(same(screen(setup), "dracula")).toBeTrue()
  const before = structuredClone(setup.config())

  await openThemes(setup)
  expect(setup.captureCharFrame()).toContain("uses the global theme")
  expect(setup.captureCharFrame()).toContain("Global theme (dracula)")
  expect(previews(setup, "dracula")).toBeTrue()
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame(() => !previews(setup, "dracula") && dialog(setup) !== undefined)
  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(setup.config()).toEqual(before)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Themes") && same(screen(setup), "dracula"))
  expect(setup.config()).toEqual(before)

  await openThemes(setup)
  await setup.mockInput.typeText("gruvbox")
  await setup.waitForFrame(() => previews(setup, "gruvbox"))
  expect(setup.config()).toEqual(before)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Themes"))
  expect(same(screen(setup), "gruvbox")).toBeTrue()
  expect(setup.config().projects).toEqual({ proj_a: { theme: { name: "gruvbox" } } })
  expect(setup.config().theme).toEqual({ name: "dracula", mode: "dark" })

  await openThemes(setup)
  expect(setup.captureCharFrame()).toContain("uses its own theme · global: dracula")
  // The first row is the global theme, then Agent colours, above the sorted themes.
  const names = Object.keys(allThemes()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  for (const _ of names.slice(0, names.indexOf("gruvbox") + 2)) setup.mockInput.pressArrow("up")
  await setup.waitForFrame(() => previews(setup, "dracula"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Themes"))
  expect(same(screen(setup), "dracula")).toBeTrue()
  expect(setup.config().projects).toBeUndefined()
  expect(setup.config().theme).toEqual({ name: "dracula", mode: "dark" })
})

test("on the home screen the folder's project theme shows, and outside a project Enter sets the global theme", async () => {
  {
    await using setup = await app({
      width: 100,
      project: "proj_home",
      config: {
        tabs: { mode: "off" },
        theme: { name: "dracula", mode: "dark" },
        projects: { proj_home: { theme: { name: "nord" } } },
      },
    })
    await setup.waitForFrame(() => same(screen(setup), "nord"))
  }
  await using setup = await app({
    width: 100,
    project: "global",
    config: { tabs: { mode: "off" }, theme: { name: "dracula", mode: "dark" } },
  })
  await setup.waitForFrame(() => same(screen(setup), "dracula"))
  await openThemes(setup)
  expect(setup.captureCharFrame()).not.toContain("Global theme (")
  await setup.mockInput.typeText("nord")
  await setup.waitForFrame(() => previews(setup, "nord"))
  expect(setup.config().theme).toEqual({ name: "dracula", mode: "dark" })
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.config().theme?.name === "nord")
  expect(setup.config().projects).toBeUndefined()
})

test("Settings shows the theme in force with its level, and its two rows write each level", async () => {
  await using setup = await app({
    width: 100,
    sessionID: alpha.id,
    config: {
      tabs: { mode: "off" },
      theme: { name: "dracula", mode: "dark" },
      projects: { proj_a: { theme: { name: "nord" } } },
    },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes(content[alpha.id]!))
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.renderer.stdin.emit("data", Buffer.from("/settings\r"))
  await setup.waitForFrame(
    (frame) => frame.includes("Settings") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("theme")
  await setup.waitForFrame((frame) => frame.includes("nord · this project") && frame.includes("Global theme"))
  const row = (title: string) =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.trimStart().startsWith(title))
  expect(row("Global theme")).toContain("dracula")

  // ← on the Theme row steps to the theme before nord and writes it for this project only.
  const names = Object.keys(allThemes()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  const before = names[names.indexOf("nord") - 1]!
  setup.mockInput.pressArrow("left")
  await setup.waitFor(() => setup.config().projects?.proj_a?.theme?.name === before)
  expect(setup.config().theme).toEqual({ name: "dracula", mode: "dark" })
  await setup.waitForFrame((frame) => frame.includes(`${before} · this project`))
})
