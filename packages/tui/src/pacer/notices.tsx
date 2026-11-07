import type { PacerNotice } from "@opencode/client"
import { TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { useConfig, type Info } from "../config"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { usePacer, type Pacer } from "../context/pacer"
import { useRoute } from "../context/route"
import { useStorage } from "../context/storage"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { stringWidth } from "../util/string-width"
import { noticeAge, noticesMore, noticesShown, noticeSubject, noticeTitle } from "./format"

// Cache notices (spec cliproxypacer-cache-notices, sections 3 and 4): each miss or partial reuse of a chat's step on
// CLIProxyPacer, as OpenCodePlus's cards stacked in the top-right corner of every TUI, over whatever is there and
// under any dialog. The store holds the service's notices; this TUI shows those its own settings (Settings ›
// CLIProxyPacer) let through. Opening one goes to the chat that sent the request, opens its Requests tab on that
// request with what changed, and dismisses it. The ages count on the store's countdown clock while cards show; nothing
// ticks while none do.

/** The widest a card is. */
const WIDTH = 64
/** A dismissal kept by this TUI alone outlives the longest lifetime, then is dropped. */
const KEEP_DISMISSED = 86_400_000

export interface NoticeSettings {
  readonly enabled: boolean
  readonly from: "all" | "chat"
  /** Minutes a notice shows after its request. */
  readonly lifetime: number
  /** The fewest tokens not reused that show a notice. */
  readonly minimum: number
  readonly kinds: "all" | "misses"
  readonly dismiss: "every-tui" | "this-tui"
}

/** This TUI's settings of the cache notices, with OpenCodePlus's defaults. */
export function noticeSettings(config: NonNullable<Info["cliproxypacer"]>["notices"]): NoticeSettings {
  return {
    enabled: config?.enabled ?? true,
    from: config?.from ?? "all",
    lifetime: config?.lifetime ?? 15,
    minimum: config?.minimum ?? 0,
    kinds: config?.kinds ?? "all",
    dismiss: config?.dismiss ?? "every-tui",
  }
}

/**
 * The notices this TUI shows at `now`, newest first: those its settings let through, within their lifetime and not
 * dismissed in this TUI alone. `root` is the top chat of the one shown, for "this chat and its subagents"; a notice
 * without a count counts as any loss.
 */
export function visibleNotices<
  Notice extends Pick<PacerNotice, "requestID" | "sessionID" | "rootID" | "verdict" | "tokens" | "at">,
>(
  notices: readonly Notice[],
  settings: NoticeSettings,
  input: { readonly now: number; readonly root?: string; readonly dismissed: Readonly<Record<string, number>> },
) {
  if (!settings.enabled) return []
  // A 15-minute lifetime shows ages up to `14 min ago`.
  const until = input.now - settings.lifetime * 60_000
  return notices.filter(
    (notice) =>
      notice.at > until &&
      (notice.tokens ?? 0) >= settings.minimum &&
      (settings.kinds === "all" || notice.verdict === "miss") &&
      (settings.from === "all" ||
        (input.root !== undefined && (notice.rootID === input.root || notice.sessionID === input.root))) &&
      input.dismissed[notice.requestID] === undefined,
  )
}

export function PacerNotices() {
  const pacer = usePacer()
  return <Show when={pacer}>{(pacer) => <Notices pacer={pacer()} />}</Show>
}

function Notices(props: { pacer: Pacer }) {
  const config = useConfig()
  const route = useRoute()
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [local, saveLocal] = useStorage().store<{ dismissed: Record<string, number> }>("pacer-notices", {
    initial: { dismissed: {} },
  })
  const settings = createMemo(() => noticeSettings(config.data.cliproxypacer?.notices))
  // The top chat of the one shown: a subagent's notices belong to it.
  const root = () => {
    if (route.data.type !== "session") return undefined
    const up = (sessionID: string, depth: number): string => {
      const parent = data.session.get(sessionID)?.parentID
      return parent === undefined || depth > 16 ? sessionID : up(parent, depth + 1)
    }
    return up(route.data.sessionID, 0)
  }
  const visible = createMemo(() =>
    visibleNotices(props.pacer.notices(), settings(), {
      now: props.pacer.now(),
      root: settings().from === "chat" ? root() : undefined,
      dismissed: local.dismissed ?? {},
    }),
  )
  props.pacer.countdown(() => visible().length > 0)

  const dismiss = (notices: readonly PacerNotice[]) => {
    if (settings().dismiss === "this-tui") {
      const at = Date.now()
      void saveLocal((draft) => {
        draft.dismissed = Object.fromEntries([
          ...Object.entries(draft.dismissed ?? {}).filter((entry) => at - entry[1] < KEEP_DISMISSED),
          ...notices.map((notice) => [notice.requestID, at] as const),
        ])
      })
      return
    }
    notices.forEach((notice) =>
      props.pacer
        .dismissNotice(notice.requestID)
        .catch((error: unknown) =>
          toast.show({ variant: "error", message: `The cache notice couldn't be dismissed: ${errorMessage(error)}` }),
        ),
    )
  }
  const open = (notice: PacerNotice) => {
    props.pacer.showRequest({ sessionID: notice.sessionID, requestID: notice.requestID })
    if (route.data.type !== "session" || route.data.sessionID !== notice.sessionID)
      route.navigate({ type: "session", sessionID: notice.sessionID })
    dismiss([notice])
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "pacer.notice.open",
        title: "Open the newest cache notice",
        group: "CLIProxyPacer",
        // Behind a dialog the cards wait: the key opens nothing under it.
        enabled: visible().length > 0 && dialog.stack.length === 0,
        run() {
          const newest = visible()[0]
          if (newest) open(newest)
        },
      },
      {
        id: "pacer.notices.dismiss",
        title: "Dismiss cache notices",
        group: "CLIProxyPacer",
        palette: true,
        enabled: visible().length > 0,
        run: () => dismiss(visible()),
      },
    ],
  }))

  const width = () => Math.min(WIDTH, dimensions().width - 6)
  const shown = () => noticesShown(dimensions().height)
  return (
    <Show when={visible().length > 0}>
      <box position="absolute" top={1} right={2} width={width()} flexDirection="column">
        <For each={visible().slice(0, shown())}>
          {(notice) => (
            <NoticeCard
              notice={notice}
              width={width()}
              now={props.pacer.now()}
              onOpen={() => open(notice)}
              onDismiss={() => dismiss([notice])}
            />
          )}
        </For>
        <Show when={noticesMore(visible().length, shown())}>
          {(more) => (
            // On the cards' background, a space either side: a text's own spaces let what is beneath show through.
            <text fg={theme.text.muted} bg={theme.background.raised.high} wrapMode="none">
              {` ${more()} `}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

function NoticeCard(props: {
  notice: PacerNotice
  width: number
  now: number
  onOpen: () => void
  onDismiss: () => void
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  // Its own memo, so a tick of the clock redraws only an age that changed.
  const age = createMemo(() => noticeAge(props.notice.at, props.now))
  // The card's border and padding take four columns; on the first line the age and × take theirs.
  const room = () => props.width - 4
  const title = () => Locale.truncateWidth(noticeTitle(props.notice), room() - stringWidth(age()) - 1 - 3)
  return (
    <box
      width="100%"
      marginBottom={1}
      border={SplitBorder.border}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.notice.verdict === "miss" ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onOpen()
      }}
    >
      <box width="100%" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
        <box flexDirection="row" width="100%">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
            {title()}
          </text>
          <text fg={theme.text.muted} flexShrink={0} marginLeft={1} wrapMode="none">
            {age()}
          </text>
          {/* Spaces around it make the click target three cells wide, not one. */}
          <text
            fg={theme.text.action.secondary.base}
            flexShrink={0}
            wrapMode="none"
            onMouseUp={(event) => {
              event.stopPropagation()
              props.onDismiss()
            }}
          >
            {" × "}
          </text>
        </box>
        <text fg={theme.text.base} wrapMode="none">
          {Locale.truncateWidth(noticeSubject(props.notice), room())}
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {Locale.truncateWidth(props.notice.cause, room())}
        </text>
      </box>
    </box>
  )
}
