/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { ConfigProvider, type Info } from "../../src/config"
import { ThemeProvider, useTheme, useThemes } from "../../src/context/theme"
import { allThemes, parseTheme } from "../../src/theme"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// openforge (spec project-themes): the shown project's theme, else the global one, else the default; writes only on a
// choice, each at its own level.

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
        <ThemeProvider
          mode="dark"
          source={{ discover: () => Promise.resolve({ mine: structuredClone(allThemes().nord) }) }}
        >
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
    background: () => theme.background.base,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

const background = (name: string) => resolveThemeDocument(parseTheme(allThemes()[name]!, name), "dark").background.base

const project = { id: "proj_a", name: "alpha" }

test("the shown project's own theme wins over the global one, which wins over the default", async () => {
  await using view = await mount({ theme: { name: "dracula" }, projects: { proj_a: { theme: { name: "gruvbox" } } } })
  expect(view.themes.selected).toBe("dracula")
  expect(view.themes.level).toBe("global")
  expect(view.background().equals(background("dracula"))).toBeTrue()

  view.themes.show({ project })
  expect(view.themes.selected).toBe("gruvbox")
  expect(view.themes.level).toBe("project")
  expect(view.themes.own).toBe("gruvbox")
  expect(view.background().equals(background("gruvbox"))).toBeTrue()

  view.themes.show({ project: { id: "proj_b", name: "beta" } })
  expect(view.themes.selected).toBe("dracula")
  expect(view.themes.own).toBeUndefined()
  expect(view.writes).toEqual([])
})

test("with no global theme the default shows, and a project's own theme still wins", async () => {
  await using view = await mount({ projects: { proj_a: { theme: { name: "nord" } } } })
  expect(view.themes.selected).toBe("opencode")
  view.themes.show({ project })
  expect(view.themes.selected).toBe("nord")
})

test("a project theme this TUI doesn't have passes to the global theme, and the catch-all project has none", async () => {
  await using view = await mount({
    theme: { name: "dracula" },
    projects: { proj_a: { theme: { name: "deleted-theme" } }, global: { theme: { name: "nord" } } },
  })
  view.themes.show({ project })
  expect(view.themes.selected).toBe("dracula")
  expect(view.themes.level).toBe("global")

  view.themes.show({ project: { id: "global", name: "global" } })
  expect(view.themes.project).toBeUndefined()
  expect(view.themes.selected).toBe("dracula")
})

test("a theme file found by discovery can be a project's theme", async () => {
  await using view = await mount({ theme: { name: "dracula" }, projects: { proj_a: { theme: { name: "mine" } } } })
  view.themes.show({ project })
  expect(view.themes.selected).toBe("mine")
})

test("a preview shows at once and writes nothing; clearing it returns to the theme in force", async () => {
  await using view = await mount({ theme: { name: "dracula" } })
  view.themes.show({ project })
  view.themes.preview("nord")
  expect(view.themes.selected).toBe("nord")
  expect(view.background().equals(background("nord"))).toBeTrue()
  view.themes.preview("gruvbox")
  expect(view.themes.selected).toBe("gruvbox")
  view.themes.preview(undefined)
  expect(view.themes.selected).toBe("dracula")
  expect(view.writes).toEqual([])
})

test("inside a project, set writes only that project's theme and shows it at once; useGlobal removes the entry", async () => {
  const settings: Info = { theme: { name: "dracula", mode: "dark" }, projects: { proj_b: { theme: { name: "nord" } } } }
  await using view = await mount(settings)
  view.themes.show({ project })

  expect(view.themes.set("gruvbox")).toBeTrue()
  expect(view.themes.selected).toBe("gruvbox")
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]).toEqual({
    theme: { name: "dracula", mode: "dark" },
    projects: { proj_b: { theme: { name: "nord" } }, proj_a: { theme: { name: "gruvbox" } } },
  })

  expect(view.themes.set("nord")).toBeTrue()
  await view.app.waitFor(() => view.writes.length === 2)
  expect(view.writes[1]?.projects?.proj_a).toEqual({ theme: { name: "nord" } })

  view.themes.useGlobal()
  expect(view.themes.selected).toBe("dracula")
  expect(view.themes.level).toBe("global")
  await view.app.waitFor(() => view.writes.length === 3)
  expect(view.writes[2]).toEqual({
    theme: { name: "dracula", mode: "dark" },
    projects: { proj_b: { theme: { name: "nord" } } },
  })
})

test("removing the last project's theme removes projects from the config", async () => {
  await using view = await mount({ theme: { name: "dracula" }, projects: { proj_a: { theme: { name: "nord" } } } })
  view.themes.show({ project })
  view.themes.useGlobal()
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]).toEqual({ theme: { name: "dracula" } })
})

test("setGlobal writes the global theme and a project with its own theme keeps it", async () => {
  await using view = await mount({ theme: { name: "dracula" }, projects: { proj_a: { theme: { name: "nord" } } } })
  view.themes.show({ project })
  expect(view.themes.setGlobal("gruvbox")).toBeTrue()
  expect(view.themes.global).toBe("gruvbox")
  expect(view.themes.selected).toBe("nord")
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]).toEqual({ theme: { name: "gruvbox" }, projects: { proj_a: { theme: { name: "nord" } } } })

  view.themes.show({ project: { id: "proj_b", name: "beta" } })
  expect(view.themes.selected).toBe("gruvbox")
})

test("outside a project set writes the global theme", async () => {
  await using view = await mount({ theme: { name: "dracula" } })
  expect(view.themes.project).toBeUndefined()
  expect(view.themes.set("nord")).toBeTrue()
  await view.app.waitFor(() => view.writes.length === 1)
  expect(view.writes[0]).toEqual({ theme: { name: "nord" } })
  expect(view.themes.set("not-a-theme")).toBeFalse()
  expect(view.writes.length).toBe(1)
})
