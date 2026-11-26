import { CliRenderEvents, SyntaxStyle, type TerminalColors } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  generateSyntax,
  resolveThemeDocument,
  themeModes,
  type ResolvedTheme,
  type SurfaceName,
} from "@opencode/theme/tui"
import {
  allThemes,
  getOpenCode2Theme,
  hasTheme,
  isThemeSource,
  parseTheme,
  setCustomThemes,
  setSystemTheme,
  subscribeThemes,
  type ThemeDocumentSource,
} from "../theme"
import { generateSystem, terminalMode } from "../theme/system"
import { AGENT_SAMPLE_HUE, AGENT_THEME, agentHue, agentSettings, agentTheme, type AgentSettings } from "../theme/agent"
import { discoverThemes } from "../theme/discovery"
import { createComponentTheme, type ComponentTheme } from "../theme/component"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { setProjectTheme, useConfig, useNewDesigns, type Config } from "../config"
import { useStorageOptional } from "./storage"
import { DevTools } from "../devtools"
import { configDirectories } from "../util/config-directories"
import type { ThemeV1Json } from "@opencode/theme/tui/v1"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const themePerformance = DevTools.register({ id: "theme-performance", title: "Theme performance" })
export type ThemeError = { name: string; error: Error }
type ThemeErrorHandler = (event: ThemeError) => void

function createThemeErrors() {
  let handler: ThemeErrorHandler | undefined
  let pending: ThemeError | undefined

  return {
    emit(name: string, cause: unknown) {
      const event = { name, error: cause instanceof Error ? cause : new Error(String(cause)) }
      if (handler) {
        handler(event)
        return
      }
      pending = event
    },
    onError(next: ThemeErrorHandler) {
      handler = next
      if (pending) {
        next(pending)
        pending = undefined
      }
      return () => {
        if (handler === next) handler = undefined
      }
    },
  }
}

const themeErrors = createThemeErrors()

export type ThemeSource = Readonly<{
  discover(): Promise<Record<string, unknown>>
  subscribeRefresh?(refresh: () => void): () => void
  /** openforge (spec custom-themes): the global themes folder, whose themes the customizer edits. */
  custom?: Readonly<{
    list(): Promise<Record<string, unknown>>
    write(name: string, theme: ThemeV1Json): Promise<void>
    remove(name: string): Promise<void>
  }>
}>

export const createThemeSource = (config: string): ThemeSource => ({
  async discover() {
    return discoverThemes(configDirectories(config, process.cwd()))
  },
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
  custom: {
    list: () => discoverThemes([config]),
    async write(name, theme) {
      const file = path.join(config, "themes", `${name}.json`)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify(theme, null, 2) + "\n")
      await rename(`${file}.tmp`, file)
    },
    remove: (name) => rm(path.join(config, "themes", `${name}.json`), { force: true }),
  },
})

const THEME_REFRESH_DELAYS = [250, 1000] as const

/**
 * openforge (spec project-themes): what the screen shows, whose theme applies. `project` is openforge's project of the
 * shown chat or of the folder a new chat starts in; the catch-all project has none.
 */
export type ThemeSubject = { project?: { id: string; name: string }; chat?: string }

type State = {
  mode: "dark" | "light"
  lock: "dark" | "light" | undefined
  ready: boolean
  /** The theme the picker shows while you move through it; written nowhere. */
  preview: string | undefined
  subject: ThemeSubject
  /** Names that failed to load, passed over until the theme files are read again or the name is chosen again. */
  failed: Record<string, true | undefined>
  /** Choices written but not yet read back from the config, so the screen changes at once. null: the project's own goes. */
  pending: { global?: string; projects: Record<string, string | null | undefined>; agent?: AgentSettings }
  /** The themes of the global themes folder: the custom themes the customizer edits. */
  custom: Record<string, true | undefined>
  /** Agent theme settings shown on this screen over the ones in force, while one is picked; written nowhere. */
  agentPreview: Partial<AgentSettings> | undefined
}

type Themes = {
  current: ComponentTheme
  currentTokens: Accessor<ResolvedTheme>
  /** The name of the theme shown: the preview, else the project's own, else the global one. */
  readonly selected: string
  /** The global theme's name, as set in the config. */
  readonly global: string
  /** The shown project's own theme, while it has one; undefined outside a project. */
  readonly own: string | undefined
  /** Whose theme shows: the project's own or the global one. */
  readonly level: "project" | "global"
  readonly project: ThemeSubject["project"]
  /** The root chat on screen, whose agent's colour the agent theme takes. */
  readonly chat: string | undefined
  all: typeof allThemes
  has: typeof hasTheme
  currentSyntax: Accessor<SyntaxStyle>
  mode: Accessor<"dark" | "light">
  modes: Accessor<readonly ("dark" | "light")[]>
  supports(mode: "dark" | "light"): boolean
  locked: Accessor<boolean>
  lock(): void
  unlock(): void
  setMode(mode?: "dark" | "light", persist?: boolean): boolean
  /** Sets the theme where the screen takes it from: the shown project's own, or the global one outside a project. */
  set(theme: string): boolean
  /** Sets the global theme; a project with its own theme keeps it. */
  setGlobal(theme: string): boolean
  /** Returns the shown project to the global theme: its own theme goes from the config. */
  useGlobal(): void
  /** Shows a theme on this screen only, until cleared with undefined. */
  preview(theme: string | undefined): void
  /** openforge (spec custom-themes): whether a theme is one of the global themes folder's, which can be edited. */
  custom(name: string): boolean
  /** Writes a custom theme into the global themes folder and reads the theme files again. */
  saveCustom(name: string, theme: ThemeV1Json): Promise<void>
  /** Renames a custom theme; the global theme, project themes and the agent theme's base of its old name take the new one. */
  renameCustom(from: string, to: string): Promise<void>
  removeCustom(name: string): Promise<void>
  /** openforge (spec agent-theme): the agent theme's settings in force. */
  readonly agent: AgentSettings
  /** Writes the agent theme's settings and shows them at once. */
  setAgent(settings: Partial<AgentSettings>): void
  /** Shows the agent theme with these settings over the ones in force, on this screen only, until cleared. */
  previewAgent(settings: Partial<AgentSettings> | undefined): void
  /**
   * openforge (workspace spec agent-badges, 3.3): where a chat's agent's hue comes from, its badge's, which its title
   * shows in too; a chat it gives none for, or with none set, takes the hash of its id (`agentHue`).
   */
  hues(source: ((chat: string) => number | undefined) | undefined): void
  show(subject: ThemeSubject): void
  afterPaint(): void
  onError(handler: ThemeErrorHandler): () => void
  readonly ready: boolean
}

type ThemeContextValue = {
  current: ComponentTheme
  themes: Themes
  readonly ready: boolean
}

const [store, setStore] = createStore<State>({
  mode: "dark",
  lock: undefined,
  ready: false,
  preview: undefined,
  subject: {},
  failed: {},
  pending: { projects: {} },
  custom: {},
  agentPreview: undefined,
})
const [themeSources, setThemeSources] = createSignal(allThemes())

subscribeThemes(setThemeSources)

const themeContext = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light"; source: ThemeSource }): ThemeContextValue => {
    const renderer = useRenderer()
    const configState = useConfig()
    const newDesigns = useNewDesigns()
    const config = configState.data
    const themes = props.source
    const cache = useStorageOptional()?.store<{ colors?: TerminalColors }>("system-theme", { initial: {} })

    setStore(
      produce((draft) => {
        const lock = config.theme?.mode === "dark" || config.theme?.mode === "light" ? config.theme.mode : undefined
        const mode = lock ?? renderer.themeMode ?? props.mode
        draft.mode = mode
        draft.lock = lock
        draft.ready = false
        draft.preview = undefined
        draft.subject = {}
        draft.failed = {}
        draft.pending = { projects: {} }
        draft.custom = {}
        draft.agentPreview = undefined
      }),
    )

    createEffect(() => {
      const mode = config.theme?.mode
      if (mode === "dark" || mode === "light") {
        pin(mode, false)
        return
      }
      if (mode === "system" && store.lock !== undefined) free(false)
    })

    const available = createMemo(
      (): Record<string, ThemeDocumentSource> =>
        newDesigns() ? { opencode2: getOpenCode2Theme(), ...themeSources() } : themeSources(),
    )
    const has = (name: string) => name === AGENT_THEME || (Boolean(name) && available()[name] !== undefined)
    const usable = (name: string | undefined) => (name && has(name) && !store.failed[name] ? name : undefined)
    const global = () => store.pending.global ?? config.theme?.name ?? "opencode"
    const own = () => {
      const id = store.subject.project?.id
      if (!id) return undefined
      if (id in store.pending.projects) return store.pending.projects[id] ?? undefined
      return config.projects?.[id]?.theme?.name
    }
    // A name this TUI doesn't have, or one that failed to load, passes to the next level. The global name is kept while
    // unavailable, as before project themes, so `selected` still names it.
    const shown = createMemo(
      () => usable(store.preview) ?? usable(own()) ?? (store.failed[global()] ? "opencode" : global()),
    )

    function syncCustomThemes() {
      return Promise.all([themes.discover(), themes.custom?.list() ?? Promise.resolve({})])
        .then(([all, custom]) => {
          batch(() => {
            setCustomThemes(all)
            setStore("custom", reconcile(Object.fromEntries(Object.keys(custom).map((name) => [name, true]))))
            setStore("failed", reconcile({}))
          })
        })
        .catch(() => {})
    }

    onMount(() => {
      // Terminal palette queries serialize with frame output. First paint uses the cached palette or built-in fallback.
      void syncCustomThemes().finally(() => {
        tokens()
        setStore("ready", true)
      })
    })

    const cachedPalette = cache?.[0].colors
    let palette = usablePalette(cachedPalette) ? cachedPalette : undefined
    const applyPalette = () => {
      if (palette) setSystemTheme(generateSystem(palette, store.mode))
    }
    if (palette) {
      const mode = store.lock ?? renderer.themeMode ?? terminalMode(palette) ?? store.mode
      if (store.mode !== mode) setStore("mode", mode)
      applyPalette()
    } else setSystemTheme(undefined)

    let canProbe = false
    let probing = false
    let queued = false
    let disposed = false
    function refreshPalette() {
      if (shown() !== "system") return
      queued = true
      if (!canProbe || probing || disposed) return

      queued = false
      probing = true
      // Clearing does not cancel a query already owned by the renderer. Share it, then run one fresh query.
      const retry = renderer.paletteDetectionStatus === "detecting"
      renderer.clearPaletteCache()
      void renderer
        .getPalette({ size: 16 })
        .then((colors) => {
          if (disposed || !usablePalette(colors)) return
          palette = colors
          const mode = store.lock ?? terminalMode(colors) ?? store.mode
          if (store.mode !== mode) setStore("mode", mode)
          applyPalette()
          void cache?.[1]((draft) => {
            draft.colors = colors
          }).catch(() => {})
        })
        .catch(() => {})
        .finally(() => {
          probing = false
          if (disposed || (!retry && !queued)) return
          refreshPalette()
        })
    }

    function afterPaint() {
      canProbe = true
      refreshPalette()
    }

    function apply(mode: "dark" | "light") {
      if (store.mode !== mode) {
        setStore("mode", mode)
        applyPalette()
      }
      refreshPalette()
    }

    function pin(mode: "dark" | "light" = store.mode, persist = true) {
      setStore("lock", mode)
      apply(mode)
      if (!persist) return
      void configState
        .update((draft) => {
          draft.theme = { ...draft.theme, mode }
        })
        .catch(() => {})
    }

    function free(persist = true) {
      setStore("lock", undefined)
      apply(renderer.themeMode ?? store.mode)
      if (!persist) return
      void configState
        .update((draft) => {
          draft.theme = { ...draft.theme, mode: "system" }
        })
        .catch(() => {})
    }

    const handleMode = (mode: "dark" | "light") => {
      if (store.lock) return
      apply(mode)
    }
    renderer.on(CliRenderEvents.THEME_MODE, handleMode)

    const handleThemeNotification = (sequence: string) => {
      if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") return false
      queueMicrotask(refreshPalette)
      return false
    }
    renderer.prependInputHandler(handleThemeNotification)

    let themeRefreshTimeouts: ReturnType<typeof setTimeout>[] = []
    const refreshThemes = () => {
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts = THEME_REFRESH_DELAYS.map((delay) =>
        setTimeout(() => {
          refreshPalette()
          if (delay === THEME_REFRESH_DELAYS[THEME_REFRESH_DELAYS.length - 1]) void syncCustomThemes()
        }, delay),
      )
    }
    const unsubscribeRefresh = themes.subscribeRefresh?.(refreshThemes)

    onCleanup(() => {
      disposed = true
      renderer.off(CliRenderEvents.THEME_MODE, handleMode)
      renderer.removeInputHandler(handleThemeNotification)
      unsubscribeRefresh?.()
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts.length = 0
    })

    createEffect(on(shown, (name) => name === "system" && refreshPalette(), { defer: true }))

    // openforge (spec agent-theme): the agent theme is its base theme, with the chosen parts in the hue of the chat on
    // screen; with no chat its base theme shows, or a sample hue while it is previewed. One document per hue and
    // settings, kept while its base theme's source is.
    // A base theme this TUI doesn't have counts as opencode.
    const agent = (): AgentSettings => {
      const settings = store.pending.agent ?? agentSettings(config.theme?.agent)
      return available()[settings.base] ? settings : { ...settings, base: "opencode" }
    }
    const agentDocuments = new WeakMap<object, Map<string, ThemeDocumentSource>>()
    const [hueSource, setHueSource] = createSignal<(chat: string) => number | undefined>()
    function loadAgent() {
      const settings = { ...agent(), ...store.agentPreview }
      const sources = available()
      const base = sources[settings.base] ? settings.base : "opencode"
      const source = sources[base]!
      const chat = store.subject.chat
      const hue = chat
        ? (hueSource()?.(chat) ?? agentHue(chat))
        : store.preview === AGENT_THEME
          ? AGENT_SAMPLE_HUE
          : undefined
      if (hue === undefined || !settings.follow.length) return loadTheme(source, base, store.mode, newDesigns())
      const key = `${hue}|${[...settings.follow].sort().join(",")}|${settings.strength}|${newDesigns()}`
      const documents = agentDocuments.get(source) ?? new Map<string, ThemeDocumentSource>()
      agentDocuments.set(source, documents)
      const document =
        documents.get(key) ??
        (agentTheme(parseTheme(source, base, { newDesigns: newDesigns() }), hue, settings) as ThemeDocumentSource)
      documents.set(key, document)
      return loadTheme(document, AGENT_THEME, store.mode, newDesigns())
    }

    const initStarted = performance.now()
    const selected = createMemo(() => {
      const sources = available()
      const name = has(shown()) ? shown() : "opencode"
      try {
        if (name === AGENT_THEME) return loadAgent()
        return loadTheme(sources[name], name, store.mode, newDesigns())
      } catch (error) {
        if (name === "opencode") throw error
        themeErrors.emit(name, error)
        setStore("failed", name, true)
        return loadTheme(sources.opencode, "opencode", store.mode, newDesigns())
      }
    })
    const modes = () => selected().modes
    const mode = () => selected().mode
    const tokens = () => selected().theme
    tokens()
    themePerformance.set("Init", `${(performance.now() - initStarted).toFixed(2)} ms`)
    const current = createComponentTheme(tokens)

    createEffect(() => renderer.setBackgroundColor(tokens().background.base))

    const currentSyntax = createSyntaxStyleMemo(() => generateSyntax(tokens(), renderer.nativeScene))
    // The choice shows at once; the pending entry goes once the config has it, or the write failed.
    function writeGlobal(theme: string) {
      setStore("pending", "global", theme)
      void configState
        .update((draft) => {
          draft.theme = { ...draft.theme, name: theme }
        })
        .catch(() => {})
        .finally(() => {
          if (store.pending.global === theme) setStore("pending", "global", undefined)
        })
    }

    function writeProject(id: string, theme: string | null) {
      setStore("pending", "projects", id, theme)
      void configState
        .update((draft) => setProjectTheme(draft, id, theme ?? undefined))
        .catch(() => {})
        .finally(() => {
          if (store.pending.projects[id] === theme) setStore("pending", "projects", id, undefined)
        })
    }

    let agentWrites = 0
    function writeAgent(settings: AgentSettings) {
      const write = ++agentWrites
      setStore("pending", "agent", reconcile(settings))
      void configState
        .update((draft) => {
          draft.theme = {
            ...draft.theme,
            agent: { base: settings.base, follow: [...settings.follow], strength: settings.strength },
          }
        })
        .catch(() => {})
        .finally(() => {
          if (write === agentWrites) setStore("pending", "agent", undefined)
        })
    }

    function choose(theme: string) {
      if (!has(theme)) return false
      setStore("failed", theme, undefined)
      return true
    }

    const service: Themes = {
      current,
      currentTokens: tokens,
      currentSyntax,
      get selected() {
        return shown()
      },
      get global() {
        return global()
      },
      get own() {
        return usable(own())
      },
      get level() {
        return usable(own()) ? "project" : "global"
      },
      get project() {
        return store.subject.project
      },
      get chat() {
        return store.subject.chat
      },
      all: available,
      has,
      mode,
      modes,
      supports: (requested) => modes().includes(requested),
      locked: () => store.lock !== undefined,
      lock: () => pin(mode()),
      unlock: free,
      setMode(requested = mode(), persist = true) {
        if (!modes().includes(requested)) return false
        pin(requested, persist)
        return true
      },
      set(theme: string) {
        const project = store.subject.project
        if (!project) return service.setGlobal(theme)
        if (!choose(theme)) return false
        writeProject(project.id, theme)
        return true
      },
      setGlobal(theme: string) {
        if (!choose(theme)) return false
        writeGlobal(theme)
        return true
      },
      useGlobal() {
        const project = store.subject.project
        if (project) writeProject(project.id, null)
      },
      preview(theme) {
        setStore("preview", theme)
      },
      custom: (name) => store.custom[name] === true,
      async saveCustom(name, theme) {
        if (!themes.custom) throw new Error("Custom themes can't be saved here")
        await themes.custom.write(name, theme)
        await syncCustomThemes()
      },
      async renameCustom(from, to) {
        const source = themes.custom ? (await themes.custom.list())[from] : undefined
        if (!themes.custom || !isThemeSource(source)) throw new Error(`No custom theme called ${from}`)
        await themes.custom.write(to, source as ThemeV1Json)
        await configState.update((draft) => {
          if (draft.theme?.name === from) draft.theme = { ...draft.theme, name: to }
          if (draft.theme?.agent?.base === from)
            draft.theme = { ...draft.theme, agent: { ...draft.theme.agent, base: to } }
          for (const [id, entry] of Object.entries(draft.projects ?? {}) as [string, Config.ProjectSettings][])
            if (entry.theme?.name === from) setProjectTheme(draft, id, to)
        })
        await themes.custom.remove(from)
        await syncCustomThemes()
      },
      async removeCustom(name) {
        await themes.custom?.remove(name)
        await syncCustomThemes()
      },
      get agent() {
        return agent()
      },
      setAgent(settings) {
        writeAgent({ ...agent(), ...settings })
      },
      previewAgent(settings) {
        setStore("agentPreview", settings ? reconcile(settings) : undefined)
      },
      hues(source) {
        setHueSource(() => source)
      },
      show(subject) {
        const project = subject.project && subject.project.id !== "global" ? subject.project : undefined
        setStore("subject", reconcile({ ...subject, project }))
      },
      afterPaint,
      onError: themeErrors.onError,
      get ready() {
        return store.ready
      },
    }
    return {
      current,
      themes: service,
      get ready() {
        return service.ready
      },
    }
  },
})

export function useThemes() {
  return themeContext.use().themes
}
export function useTheme(): ComponentTheme {
  return themeContext.use().current
}
export const ThemeProvider = themeContext.provider

/** Switches the ambient theme surface without remounting children; undefined inherits the enclosing view. */
export function ThemeContextProvider(props: ParentProps<{ context: SurfaceName | undefined }>) {
  const value = themeContext.use()
  const current = createComponentTheme(() => {
    const name = props.context
    return name ? value.themes.currentTokens().surface(name) : value.current
  })
  return (
    <themeContext.context.Provider value={{ current, themes: value.themes, ready: value.ready }}>
      {props.children}
    </themeContext.context.Provider>
  )
}

function usablePalette(colors: TerminalColors | undefined): colors is TerminalColors {
  return Boolean(
    colors && (colors.defaultBackground ?? colors.palette[0]) && (colors.defaultForeground ?? colors.palette[7]),
  )
}

function loadTheme(source: ThemeDocumentSource, name: string, requested: "dark" | "light", newDesigns: boolean) {
  const document = parseTheme(source, name, { newDesigns })
  const modes = themeModes(document)
  const mode = modes.includes(requested) ? requested : (modes[0] ?? requested)
  return { modes, mode, theme: resolveThemeDocument(document, mode) }
}

export function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  const retained = new Set<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    retained.add(style)
    void renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = factory()
    if (previous) release(previous)
    return current
  })
}
