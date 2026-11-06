import type { PacerRequest } from "@opencode/client"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, For, Match, onCleanup, Show, Switch, untrack, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { Keymap } from "../../../context/keymap"
import { usePacer, type Pacer, type PacerFilter } from "../../../context/pacer"
import { useRoute } from "../../../context/route"
import { useStorage } from "../../../context/storage"
import { useTheme } from "../../../context/theme"
import { clockTime, promptChangeLines, requestHeader, requestRow, requestTone } from "../../../pacer/format"
import { useToast } from "../../../ui/toast"
import { errorMessage } from "../../../util/error"
import { context as sessionContext } from "../render-context"
import { useComposerTab } from "./context"

// The Requests tab (spec cliproxypacer-step-1, section 7): the shown chat's requests at CPP with its subagents',
// newest first, after Terminals, for chats on CPP. It draws what the store holds and reads nothing when it opens:
// the store read the first page of both filters when the chat was shown, and what changed for their newest rows, where
// the tab opens. Rows keep one line. A cursor on the newest row stays on the newest, so requests arriving while the
// tab is watched come in under it; on any other row it is anchored by the request's ID, so a new request at the top
// never moves it to another one. Only the rows on screen are mounted, so 500 rows scroll as 6 do. Ctrl+Enter or
// Alt+Enter shows what changed in place of the list.

/** Rows on screen; the list mounts no more than these. */
const LIST_ROWS = 6
/** The composer's lines around a tab's content: its padding, the tab bar, the hints and the gaps between them. */
const COMPOSER_CHROME = 6
/** Rows left before the end of the held rows when the next page is read. */
const MORE_AHEAD = 10

export function RequestsTab(props: { sessionID: string }) {
  const pacer = usePacer()
  return <Show when={pacer}>{(pacer) => <Requests pacer={pacer()} sessionID={props.sessionID} />}</Show>
}

function Requests(props: { pacer: Pacer; sessionID: string }) {
  const composer = useComposerTab()
  const theme = useTheme()
  const toast = useToast()
  const navigate = useRoute().navigate
  const shortcuts = Keymap.useShortcuts()
  const dimensions = useTerminalDimensions()
  const session = useContext(sessionContext)
  // The session route remounts on navigation, so the filter lives in TUI memory and only ctrl+a changes it.
  const [filter, updateFilter] = useStorage().memory("requests-filter", { initial: { misses: false } })
  const [view, setView] = createStore({
    selected: {} as Partial<Record<PacerFilter, string>>,
    top: {} as Partial<Record<PacerFilter, string>>,
    /** The request whose prompt change shows in place of the list. */
    detail: undefined as string | undefined,
    /** Ctrl+Enter on a row whose change isn't held yet: the list stays until it is. */
    pending: undefined as string | undefined,
    detailTop: 0,
  })

  const visible = () => props.pacer.active(props.sessionID)
  const active = () => composer.active("requests")
  const which = (): PacerFilter => (filter.misses ? "misses" : "all")
  const page = () => props.pacer.page(props.sessionID, which())
  const items = () => page()?.items ?? []
  const noPacer = () => props.pacer.state() === "no-pacer"
  const stale = () => props.pacer.stale(page())
  // Frozen at the first frame it is stale, so CPP coming back swaps the rows and the notice in one frame.
  const asOf = createMemo<number | undefined>((previous) => {
    if (!stale()) return undefined
    return previous ?? props.pacer.status()?.asOf ?? page()?.asOf
  })
  const width = createMemo(() => Math.max(20, (session?.width ?? dimensions().width - 4) - 6))

  createEffect(() => {
    if (!visible()) return
    const cleanup = untrack(() =>
      composer.register({
        id: "requests",
        label: "Requests",
        order: 1,
        hints: () => {
          if (view.detail !== undefined)
            return [
              { label: "back", shortcut: "esc" },
              { label: "scroll", shortcut: "↑/↓" },
            ]
          return [
            ...(items().length
              ? [
                  { label: "go to", shortcut: shortcuts.get("composer.request.select") ?? "" },
                  { label: "what changed", shortcut: shortcuts.get("composer.request.detail") ?? "" },
                ]
              : []),
            {
              label: `show ${filter.misses ? "all" : "misses"}`,
              shortcut: shortcuts.get("composer.request.toggle-misses") ?? "",
            },
          ]
        },
      }),
    )
    onCleanup(cleanup)
  })

  const selectedIndex = createMemo(() => {
    const id = view.selected[which()]
    if (id === undefined) return 0
    return Math.max(
      0,
      items().findIndex((request) => request.id === id),
    )
  })
  const height = () => Math.min(LIST_ROWS, items().length)
  const topIndex = createMemo(() => {
    const id = view.top[which()]
    const raw =
      id === undefined
        ? 0
        : Math.max(
            0,
            items().findIndex((request) => request.id === id),
          )
    return listTop(raw, selectedIndex(), height(), items().length)
  })
  const shownRows = createMemo(() => items().slice(topIndex(), topIndex() + height()))
  const selected = () => items()[selectedIndex()]

  // A tab opens on the newest row, and while the cursor stays there it is on the newest row: requests arriving as the
  // tab is watched come in under it, on the top line. Moved to another row, the selection holds that request wherever
  // rows arrive. No selection held means the newest.
  createEffect(() => {
    if (active()) return
    setView({ selected: {}, top: {}, detail: undefined, pending: undefined, detailTop: 0 })
  })

  const moveTo = (index: number) => {
    const list = items()
    if (list.length === 0) return
    const next = Math.max(0, Math.min(index, list.length - 1))
    const top = listTop(topIndex(), next, Math.min(LIST_ROWS, list.length), list.length)
    batch(() => {
      setView("pending", undefined)
      setView("selected", which(), next === 0 ? undefined : list[next]!.id)
      setView("top", which(), top === 0 ? undefined : list[top]!.id)
    })
    // What changed is read ahead for the row the cursor reaches; the newest row's, where the tab opens, was read with
    // the first page, so opening the tab reads nothing.
    props.pacer.cursor(list[next]!.id)
    if (next >= list.length - MORE_AHEAD) props.pacer.more(props.sessionID, which())
  }

  const go = () => {
    const request = selected()
    if (!request) return
    const sessionID = request.subagent && request.sessionID ? request.sessionID : props.sessionID
    props.pacer.requestJump({ sessionID, request })
    if (sessionID !== props.sessionID) navigate({ type: "session", sessionID })
  }

  const toggleDetail = () => {
    if (view.detail !== undefined) {
      setView({ detail: undefined, detailTop: 0 })
      return
    }
    const request = selected()
    if (!request) return
    // Back from what changed is on the same row, even if newer requests came meanwhile.
    setView("selected", which(), request.id)
    if (props.pacer.held(request.id) !== undefined) {
      setView({ detail: request.id, detailTop: 0, pending: undefined })
      return
    }
    setView("pending", request.id)
    props.pacer.prompt(request.id).then(
      () => {
        if (view.pending === request.id) setView({ detail: request.id, detailTop: 0, pending: undefined })
      },
      (error: unknown) => {
        if (view.pending !== request.id) return
        setView("pending", undefined)
        toast.show({ variant: "error", message: `What changed couldn't be read: ${errorMessage(error)}` })
      },
    )
  }

  const change = () => (view.detail === undefined ? undefined : props.pacer.held(view.detail))
  const lines = createMemo(() => {
    const current = change()
    if (current === undefined) return undefined
    if (current === null)
      return { head: [{ text: "CPP has no record of this request", tone: "muted" as const }], items: [] }
    return promptChangeLines(current)
  })
  // The footer grows to at most half the window; the items scroll under the lines above them.
  const detailRows = createMemo(() => {
    const current = lines()
    if (!current) return 0
    const room = Math.max(current.head.length + 1, Math.floor(dimensions().height / 2) - COMPOSER_CHROME)
    return Math.min(current.items.length, room - current.head.length)
  })
  const scrollDetail = (delta: number) => {
    const current = lines()
    if (!current) return
    setView("detailTop", (top) => Math.max(0, Math.min(top + delta, current.items.length - detailRows())))
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => active() && view.detail === undefined,
    priority: 1,
    commands: [
      {
        id: "composer.request.up",
        title: "Previous request",
        group: "Composer",
        run() {
          if (selectedIndex() === 0) {
            composer.close()
            return
          }
          moveTo(selectedIndex() - 1)
        },
      },
      { id: "composer.request.down", title: "Next request", group: "Composer", run: () => moveTo(selectedIndex() + 1) },
      {
        id: "composer.request.page.up",
        title: "Previous requests",
        group: "Composer",
        bind: "pageup",
        run: () => moveTo(selectedIndex() - LIST_ROWS),
      },
      {
        id: "composer.request.page.down",
        title: "Next requests",
        group: "Composer",
        bind: "pagedown",
        run: () => moveTo(selectedIndex() + LIST_ROWS),
      },
      { id: "composer.request.select", title: "Go to where the request ended", group: "Composer", run: go },
      {
        id: "composer.request.toggle-misses",
        title: "Toggle cache misses",
        group: "Composer",
        bind: "ctrl+a",
        run() {
          const next: PacerFilter = filter.misses ? "all" : "misses"
          // The other filter's first page is held too, so this draws at once; a row in both stays selected.
          const current = selected()
          const list = props.pacer.page(props.sessionID, next)?.items ?? []
          const keep = list.find((request) => request.id === current?.id) ?? list[0]
          batch(() => {
            updateFilter((draft) => (draft.misses = next === "misses"))
            setView("pending", undefined)
            setView("top", next, undefined)
            setView("selected", next, keep === list[0] ? undefined : keep?.id)
          })
          if (keep) props.pacer.cursor(keep.id)
        },
      },
    ],
  }))
  // The same key shows what changed and goes back; Esc goes back too, before the composer's own Esc closes it.
  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => active(),
    priority: 2,
    commands: [{ id: "composer.request.detail", title: "Show what changed", group: "Composer", run: toggleDetail }],
  }))
  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => active() && view.detail !== undefined,
    priority: 2,
    commands: [
      { bind: "escape", title: "Back to the requests", group: "Composer", run: toggleDetail },
      { bind: "up", title: "Scroll up", group: "Composer", run: () => scrollDetail(-1) },
      { bind: "down", title: "Scroll down", group: "Composer", run: () => scrollDetail(1) },
      { bind: "pageup", title: "Page up", group: "Composer", run: () => scrollDetail(-Math.max(1, detailRows())) },
      { bind: "pagedown", title: "Page down", group: "Composer", run: () => scrollDetail(Math.max(1, detailRows())) },
    ],
  }))

  const toneColor = (tone: "base" | "muted" | "warning" | "error") =>
    tone === "warning"
      ? theme.text.feedback.warning.base
      : tone === "error"
        ? theme.text.feedback.error.base
        : tone === "muted"
          ? theme.text.muted
          : theme.text.base

  return (
    <Show when={active() && visible()}>
      <Switch>
        <Match when={lines()}>
          {(current) => (
            <box flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
              <For each={current().head}>
                {(line) => (
                  <text fg={toneColor(line.tone)} wrapMode="none" truncate>
                    {line.text}
                  </text>
                )}
              </For>
              <For each={current().items.slice(view.detailTop, view.detailTop + detailRows())}>
                {(line) => (
                  <text fg={toneColor(line.tone)} wrapMode="none" truncate>
                    {line.text}
                  </text>
                )}
              </For>
            </box>
          )}
        </Match>
        <Match when={noPacer()}>
          <text fg={theme.text.muted}> This proxy has no pacer, so it keeps no request records</text>
        </Match>
        <Match when={true}>
          <box flexDirection="column" flexShrink={0}>
            <box paddingLeft={1} paddingRight={1}>
              <Switch>
                <Match when={asOf() !== undefined}>
                  <text fg={theme.text.muted} wrapMode="none" truncate>
                    CPP unreachable · as of {clockTime(asOf()!)}
                  </text>
                </Match>
                <Match when={page() && items().length === 0}>
                  <text fg={theme.text.muted}>{filter.misses ? "No cache misses yet" : "No requests yet"}</text>
                </Match>
                <Match when={!page() && props.pacer.failed(props.sessionID)}>
                  {(failed) => (
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      The requests couldn't be read: {failed()}
                    </text>
                  )}
                </Match>
                <Match when={true}>
                  <text fg={theme.text.muted} attributes={TextAttributes.DIM} wrapMode="none">
                    {requestHeader(width())}
                  </text>
                </Match>
              </Switch>
            </box>
            <box
              flexDirection="column"
              flexShrink={0}
              onMouseScroll={(event) => {
                if (event.scroll?.direction === "up") moveTo(selectedIndex() - 1)
                if (event.scroll?.direction === "down") moveTo(selectedIndex() + 1)
              }}
            >
              <For each={shownRows()}>
                {(request) => (
                  <RequestRow
                    request={request}
                    width={width()}
                    selected={request.id === selected()?.id}
                    stale={asOf() !== undefined}
                    onSelect={() => moveTo(items().indexOf(request))}
                  />
                )}
              </For>
            </box>
          </box>
        </Match>
      </Switch>
    </Show>
  )
}

function RequestRow(props: {
  request: PacerRequest
  width: number
  selected: boolean
  stale: boolean
  onSelect: () => void
}) {
  const theme = useTheme()
  const text = createMemo(() => requestRow(props.request, props.width))
  const fg = () => {
    if (props.selected) return theme.text.action.primary.focused
    if (props.stale) return theme.text.faint
    const tone = requestTone(props.request)
    if (tone === "warning") return theme.text.feedback.warning.base
    if (tone === "error") return theme.text.feedback.error.base
    return theme.text.base
  }
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? theme.background.action.primary.focused : theme.background.action.primary.base}
      onMouseUp={props.onSelect}
    >
      <text
        fg={fg()}
        attributes={props.selected ? TextAttributes.BOLD : props.stale ? TextAttributes.DIM : undefined}
        wrapMode="none"
      >
        {text()}
      </text>
    </box>
  )
}

/** The first row on screen: kept where it was, unless the selection would leave the screen or rows run out. */
export function listTop(top: number, selected: number, height: number, length: number) {
  if (height <= 0) return 0
  return Math.max(0, Math.min(Math.max(top, selected - height + 1), selected, length - height))
}
