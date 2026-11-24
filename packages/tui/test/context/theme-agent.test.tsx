/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { resolveThemeDocument, rgbToOklch } from "@opencode/theme/tui"
import type { RGBA } from "@opentui/core"
import { ConfigProvider, type Info } from "../../src/config"
import { ThemeProvider, useTheme, useThemes } from "../../src/context/theme"
import { allThemes, parseTheme } from "../../src/theme"
import { AGENT_SAMPLE_HUE, agentHue } from "../../src/theme/agent"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// openforge (spec agent-theme): the theme "agent" shows its base theme with the chosen parts in the hue of the chat on
// screen; picking it globally or for a project turns it on, any other theme turns it off.

async function mount(settings: Info) {
  const temporary = await tmpdir()
  const writes: Info[] = []
  let themes!: ReturnType<typeof useThemes>
  let theme!: ReturnType<typeof useTheme>
  function Probe() {
    themes = useThemes()
    theme = useTheme()
    return null
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: temporary.path }}>
      <ConfigProvider
        config={createTuiResolvedConfig(settings)}
        service={{
          get: async () => settings,
          update: async (update) => {
            update(settings)
            writes.push(structuredClone(settings))
            return settings
          },
        }}
      >
        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    </TestTuiContexts>
  ))
  app.renderer.start()
  await app.waitForFrame(() => themes !== undefined && themes.ready)
  return {
    app,
    writes,
    get themes() {
      return themes
    },
    get theme() {
      return theme
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

const base = (name: string) => resolveThemeDocument(parseTheme(allThemes()[name]!, name), "dark")
const hue = (color: RGBA) => rgbToOklch(color.r, color.g, color.b).h
const near = (color: RGBA, expected: number) => Math.abs(((hue(color) - expected + 540) % 360) - 180) < 6

// Two chats whose hues are far apart.
const one = "ses_alpha"
const two = Array.from({ length: 200 }, (_, index) => `ses_beta${index}`).find(
  (id) => Math.abs(((agentHue(id) - agentHue(one) + 540) % 360) - 180) >= 90,
)!
const project = { id: "proj_a", name: "alpha" }

test("the agent theme takes each chat's hue on its background and panels, and the base theme's colours elsewhere", async () => {
  await using view = await mount({ theme: { name: "agent", mode: "dark" } })
  expect(view.themes.selected).toBe("agent")
  // No chat on screen: the base theme.
  expect(view.theme.background.base.equals(base("opencode").background.base)).toBeTrue()

  view.themes.show({ project, chat: one })
  const first = view.theme.background.base
  expect(near(first, agentHue(one))).toBeTrue()
  expect(near(view.theme.background.raised.base, agentHue(one))).toBeTrue()
  expect(view.theme.text.base.equals(base("opencode").text.base)).toBeTrue()
  expect(view.theme.syntax.keyword.equals(base("opencode").syntax.keyword)).toBeTrue()

  view.themes.show({ project, chat: two })
  expect(near(view.theme.background.base, agentHue(two))).toBeTrue()
  expect(view.theme.background.base.equals(first)).toBeFalse()

  view.themes.show({ project, chat: one })
  expect(view.theme.background.base.equals(first)).toBeTrue()
  expect(view.writes).toEqual([])
})

test("its settings choose the base theme, the parts that follow and how strongly; the rest stays the base's", async () => {
  await using view = await mount({
    theme: {
      name: "agent",
      mode: "dark",
      agent: { base: "dracula", follow: ["text", "headings"], strength: "strong" },
    },
  })
  view.themes.show({ project, chat: one })
  expect(view.themes.agent).toEqual({ base: "dracula", follow: ["text", "headings"], strength: "strong" })
  expect(view.theme.background.base.equals(base("dracula").background.base)).toBeTrue()
  expect(near(view.theme.text.base, agentHue(one))).toBeTrue()
  expect(near(view.theme.markdown.heading, agentHue(one))).toBeTrue()
  expect(view.theme.text.feedback.error.base.equals(base("dracula").text.feedback.error.base)).toBeTrue()
})

test("setAgent shows at once and writes theme.agent; a base theme that's gone falls back to opencode", async () => {
  await using view = await mount({ theme: { name: "agent", mode: "dark", agent: { base: "deleted-theme" } } })
  view.themes.show({ project, chat: one })
  expect(view.themes.agent.base).toBe("opencode")
  expect(near(view.theme.background.base, agentHue(one))).toBeTrue()

  view.themes.setAgent({ follow: ["borders"] })
  expect(view.theme.background.base.equals(base("opencode").background.base)).toBeTrue()
  expect(near(view.theme.border.base, agentHue(one))).toBeTrue()
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]?.theme).toEqual({
    name: "agent",
    mode: "dark",
    agent: { base: "opencode", follow: ["borders"], strength: "clear" },
  })
})

test("picking it for a project turns it on there only; picking another theme turns it off", async () => {
  await using view = await mount({ theme: { name: "nord", mode: "dark" } })
  view.themes.show({ project, chat: one })
  expect(view.themes.set("agent")).toBeTrue()
  expect(view.themes.own).toBe("agent")
  expect(near(view.theme.background.base, agentHue(one))).toBeTrue()
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]?.projects).toEqual({ proj_a: { theme: { name: "agent" } } })

  view.themes.show({ project: { id: "proj_b", name: "beta" }, chat: two })
  expect(view.theme.background.base.equals(base("nord").background.base)).toBeTrue()

  view.themes.show({ project, chat: one })
  view.themes.set("gruvbox")
  expect(view.theme.background.base.equals(base("gruvbox").background.base)).toBeTrue()
})

test("previewed with no chat on screen it shows a sample hue; a previewed base shows without being written", async () => {
  await using view = await mount({ theme: { name: "nord", mode: "dark" } })
  view.themes.preview("agent")
  expect(near(view.theme.background.base, AGENT_SAMPLE_HUE)).toBeTrue()
  view.themes.previewAgent({ base: "dracula", follow: ["text"] })
  expect(view.theme.background.base.equals(base("dracula").background.base)).toBeTrue()
  expect(near(view.theme.text.base, AGENT_SAMPLE_HUE)).toBeTrue()
  view.themes.previewAgent(undefined)
  view.themes.preview(undefined)
  expect(view.theme.background.base.equals(base("nord").background.base)).toBeTrue()
  expect(view.writes).toEqual([])
})

test("a theme of another name stays its own: the agent theme is reached only by its name", async () => {
  await using view = await mount({ theme: { name: "dracula", mode: "dark" } })
  view.themes.show({ project, chat: one })
  expect(view.theme.background.base.equals(base("dracula").background.base)).toBeTrue()
  expect(view.themes.has("agent")).toBeTrue()
  expect(Object.keys(view.themes.all())).not.toContain("agent")
})
