import { createEffect, createMemo, For, onCleanup, Show, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../../context/theme"
import { SplitBorder } from "../../../ui/border"
import { Keymap } from "../../../context/keymap"
import { SubagentsTab } from "./subagents-tab"
import { ShellTab } from "./shell-tab"
import { TerminalsTab } from "./terminals-tab"
import { RequestsTab } from "./requests-tab"
import { ComposerContext, type ComposerTab } from "./context"
import { ActiveTab, COMPOSER_FRAME, composerBar } from "./bar"
import { context as sessionContext } from "../render-context"

export type ComposerProps = {
  sessionID: string
  open: boolean
  defaultTab?: string
  onClose?: () => void
  terminals?: boolean
  visibleTerminalID?: string
}

export function Composer(props: ComposerProps) {
  const theme = useTheme()

  const [store, setStore] = createStore({
    tabs: {} as Record<string, ComposerTab>,
    active: "",
  })

  const tabList = createMemo(() => Object.values(store.tabs).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)))
  const activeTab = createMemo(() => tabList().find((t) => t.id === store.active))
  const footerHints = createMemo(() => activeTab()?.hints?.() ?? [])
  const session = useContext(sessionContext)
  const dimensions = useTerminalDimensions()
  const bar = createMemo(() =>
    composerBar({
      width: (session?.width ?? dimensions().width - 4) - COMPOSER_FRAME,
      labels: tabList().map((t) => t.label),
      hints: footerHints(),
    }),
  )

  // Set active tab when opened
  createEffect(() => {
    if (!props.open) return
    const tabs = tabList()
    if (tabs.length === 0) return
    const match = props.defaultTab && tabs.find((t) => t.id === props.defaultTab)
    setStore("active", match ? match.id : tabs[0].id)
  })

  function close() {
    props.onClose?.()
  }

  const ctx = {
    register(tab: ComposerTab) {
      setStore("tabs", tab.id, tab)
      if (!store.active) setStore("active", tab.id)
      return () => setStore("tabs", tab.id, undefined!)
    },
    active(id: string) {
      return props.open && store.active === id
    },
    select(id: string) {
      setStore("active", id)
    },
    close,
  }

  const keymap = Keymap.use()
  createEffect(() => {
    if (!props.open) return
    const popMode = keymap.mode.push("composer")
    onCleanup(popMode)
  })

  const switchTab = (dir: number) => {
    const tabs = tabList()
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === store.active)
    setStore("active", tabs[(idx + dir + tabs.length) % tabs.length].id)
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => props.open,
    priority: 1,
    commands: [
      { bind: "left", title: "Previous tab", group: "Composer", run: () => switchTab(-1) },
      { bind: "right", title: "Next tab", group: "Composer", run: () => switchTab(1) },
      { bind: "escape", title: "Close composer", group: "Composer", run: close },
      { bind: "ctrl+c", title: "Close composer", group: "Composer", run: close },
    ],
  }))

  return (
    <ComposerContext.Provider value={ctx}>
      <box flexShrink={0} visible={props.open}>
        <box
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border.base}
          backgroundColor={theme.background.raised.base}
          paddingLeft={1}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box gap={1}>
            <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
              <Show
                when={tabList().length > 1 && bar().all}
                fallback={
                  <ActiveTab label={activeTab()?.label ?? tabList()[0]?.label ?? ""} more={tabList().length > 1} />
                }
              >
                <box flexDirection="row" gap={2}>
                  <For each={tabList()}>
                    {(t) => {
                      const isActive = createMemo(() => store.active === t.id)
                      return (
                        <text
                          fg={isActive() ? theme.text.base : theme.text.muted}
                          attributes={isActive() ? TextAttributes.BOLD : undefined}
                        >
                          {t.label}
                        </text>
                      )
                    }}
                  </For>
                </box>
              </Show>
              <text fg={theme.text.muted} onMouseUp={close}>
                esc
              </text>
            </box>
            <SubagentsTab sessionID={props.sessionID} />
            <ShellTab sessionID={props.sessionID} />
            <Show when={props.terminals}>
              <TerminalsTab sessionID={props.sessionID} visibleTerminalID={props.visibleTerminalID} />
            </Show>
            <RequestsTab sessionID={props.sessionID} />
            <box flexDirection="row" gap={2} paddingLeft={1} flexShrink={0}>
              <For each={bar().hints}>
                {(hint) => (
                  <text>
                    <span style={{ fg: theme.text.base }}>
                      <b>{hint.label}</b>{" "}
                    </span>
                    <span style={{ fg: theme.text.muted }}>{hint.shortcut}</span>
                  </text>
                )}
              </For>
              <Show when={bar().tabs}>
                <text>
                  <span style={{ fg: theme.text.base }}>
                    <b>tabs</b>{" "}
                  </span>
                  <span style={{ fg: theme.text.muted }}>←/→</span>
                </text>
              </Show>
            </box>
          </box>
        </box>
      </box>
    </ComposerContext.Provider>
  )
}
