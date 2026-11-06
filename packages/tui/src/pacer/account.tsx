import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { usePacer, type Pacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import { clockTime, forceUseLine, nextUseLine, windowLine } from "./format"

// The sidebar's Account section (spec cliproxypacer-step-1, section 5), where Context was: the account serving the
// chat, or the one that served it last, its windows, where the chat goes next once its cache is cold, and a forced
// move. Greyed with "as of" while CPP is unreachable, "no pacer" on a plain proxy, hidden for chats on other
// providers (also once a chat moves to one) and when no CPP is set up.

export function PacerAccount(props: { sessionID: string }) {
  const pacer = usePacer()
  return <Show when={pacer}>{(pacer) => <AccountSection pacer={pacer()} sessionID={props.sessionID} />}</Show>
}

function AccountSection(props: { pacer: Pacer; sessionID: string }) {
  const theme = useTheme()
  const active = () => props.pacer.current(props.sessionID)
  const noPacer = () => props.pacer.state() === "no-pacer"
  const view = () => (active() && !noPacer() ? props.pacer.view(props.sessionID) : undefined)
  const account = createMemo(() => {
    const alias = view()?.value.account
    return alias === undefined ? undefined : props.pacer.accounts()?.value.items.find((item) => item.alias === alias)
  })
  // Frozen at the first frame it is stale, as the toolbar's item is.
  const asOf = createMemo<number | undefined>((previous) => {
    const current = view()
    if (!current || !(props.pacer.stale(current) || props.pacer.stale(props.pacer.accounts()))) return undefined
    return previous ?? props.pacer.status()?.asOf ?? current.value.asOf
  })
  const at = () => asOf() ?? props.pacer.now()
  const windows = createMemo(() => (account()?.windows ?? []).map((window) => windowLine(window, at())))
  props.pacer.countdown(
    () =>
      asOf() === undefined &&
      (account()?.windows.some((window) => window.resetsAt !== undefined || window.staleAt !== undefined) ?? false),
  )
  // Greyed as the toolbar's item is: faint, dimmed.
  const fg = (color: "base" | "muted") => (asOf() === undefined ? theme.text[color] : theme.text.faint)
  const attributes = () => (asOf() === undefined ? 0 : TextAttributes.DIM)

  return (
    <Show when={active() && (noPacer() || view())}>
      <box>
        <text fg={theme.text.base}>
          <b>Account</b>
        </text>
        <Show when={!noPacer()} fallback={<text fg={theme.text.muted}>no pacer</text>}>
          <Show when={view()?.value.account}>
            {(alias) => (
              <text fg={fg("base")} attributes={attributes()}>
                {alias()}
              </text>
            )}
          </Show>
          <For each={windows()}>
            {(line) => (
              <text fg={fg("muted")} attributes={attributes()}>
                {line}
              </text>
            )}
          </For>
          <Show when={view()?.value.nextUse}>
            {(next) => (
              <text fg={fg("muted")} attributes={attributes()}>
                {nextUseLine(next())}
              </text>
            )}
          </Show>
          <Show when={view()?.value.forceUse}>
            {(force) => (
              <text
                fg={asOf() === undefined && force().when === "now" ? theme.text.feedback.warning.base : fg("muted")}
                attributes={attributes()}
              >
                {forceUseLine(force())}
              </text>
            )}
          </Show>
          <Show when={asOf()}>
            {(time) => (
              <text fg={theme.text.faint} attributes={TextAttributes.DIM}>
                as of {clockTime(time())}
              </text>
            )}
          </Show>
        </Show>
      </box>
    </Show>
  )
}
