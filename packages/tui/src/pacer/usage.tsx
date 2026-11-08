import type { PacerAccount } from "@opencode/client"
import { TextAttributes, type BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Index, Show } from "solid-js"
import { useData } from "../context/data"
import { usePacer, type Pacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import {
  chatAccount,
  clockTime,
  usageAccounts,
  usageLabelWidth,
  usageLine,
  usageMeter,
  usageProvider,
  usageTags,
  type UsageMeter,
  type UsageTag,
  type UsageTone,
} from "./format"

// The sidebar's Usage section (spec cliproxypacer-usage-meters), where Context was: OpenCodePlus's usage meters for
// every account of the provider serving the chat's model, each window a bar colored by what is left, with the account
// serving the chat and the one it moves to tagged. It follows the model picked for the chat now, as the prompt shows
// it. Greyed with "as of" while CPP is unreachable, "no pacer" on a plain proxy, hidden while the model picked is
// another provider's and when no CPP is set up.

/** `model`: the ID of CPP's model picked for the chat now; undefined while it is another provider's. */
export function PacerUsage(props: { sessionID: string; model: string | undefined }) {
  const pacer = usePacer()
  return (
    <Show when={pacer}>
      {(pacer) => <UsageSection pacer={pacer()} sessionID={props.sessionID} model={props.model} />}
    </Show>
  )
}

/** The sidebar's room for a line, until the section has measured its own. */
const SIDEBAR_WIDTH = 37

function UsageSection(props: { pacer: Pacer; sessionID: string; model: string | undefined }) {
  const theme = useTheme()
  const data = useData()
  const [width, setWidth] = createSignal(SIDEBAR_WIDTH)
  const active = () => props.model !== undefined && props.pacer.shows(props.sessionID)
  const noPacer = () => props.pacer.state() === "no-pacer"
  const view = () => (active() && !noPacer() ? props.pacer.view(props.sessionID) : undefined)
  const items = () => props.pacer.accounts()?.value.items ?? []
  const serving = createMemo(() => chatAccount(items(), view()?.value))
  const usage = createMemo(() => {
    if (!active() || noPacer() || props.model === undefined) return { accounts: [], chat: undefined }
    return usageAccounts({
      accounts: items(),
      model: props.model,
      chat: view()?.value,
      models: props.pacer.models()?.value,
    })
  })
  const shown = () => usage().accounts
  const providers = createMemo(() => new Set(shown().map((account) => account.provider.toLowerCase())).size > 1)
  // Frozen at the first frame it is stale, as the toolbar's item is.
  const asOf = createMemo<number | undefined>((previous) => {
    if (shown().length === 0) return undefined
    const chat = view()
    if (!(props.pacer.stale(props.pacer.accounts()) || (chat !== undefined && props.pacer.stale(chat))))
      return undefined
    return previous ?? props.pacer.status()?.asOf ?? props.pacer.accounts()?.value.asOf
  })
  const at = () => asOf() ?? props.pacer.now()
  props.pacer.countdown(
    () =>
      asOf() === undefined &&
      shown().some((account) =>
        account.windows.some((window) => window.resetsAt !== undefined || window.staleAt !== undefined),
      ),
  )
  const running = () => data.session.status(props.sessionID) === "running"

  return (
    <Show when={active() && (noPacer() || shown().length > 0)}>
      <box
        onSizeChange={function (this: BoxRenderable) {
          setWidth(this.width)
        }}
      >
        <text fg={theme.text.base}>
          <b>Usage</b>
        </text>
        <Show when={!noPacer()} fallback={<text fg={theme.text.muted}>no pacer</text>}>
          <Index each={shown()}>
            {(account) => (
              <AccountMeters
                account={account()}
                tags={usageTags({ account: account(), serving: serving(), chat: usage().chat, running: running() })}
                provider={providers()}
                width={width()}
                at={at()}
                greyed={asOf() !== undefined}
              />
            )}
          </Index>
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

function AccountMeters(props: {
  account: PacerAccount
  tags: UsageTag[]
  provider: boolean
  width: number
  at: number
  greyed: boolean
}) {
  const theme = useTheme()
  const labelWidth = () => usageLabelWidth(props.account.windows)
  // Greyed as the toolbar's item is: faint, dimmed.
  const fg = <Color,>(color: Color) => (props.greyed ? theme.text.faint : color)
  const tagColor = (tone: UsageTag["tone"]) => fg(theme.text.feedback[tone].base)
  const barColor = (tone: UsageTone) =>
    fg(
      tone === "critical"
        ? theme.text.feedback.error.base
        : tone === "low"
          ? theme.text.feedback.warning.base
          : tone === "normal"
            ? theme.text.feedback.success.base
            : theme.text.muted,
    )
  return (
    <box flexShrink={0}>
      <box flexDirection="row">
        <text
          fg={fg(theme.text.base)}
          attributes={props.greyed ? TextAttributes.DIM : 0}
          wrapMode="none"
          truncate
          flexShrink={1}
        >
          <b>{props.account.alias}</b>
          <Show when={props.provider && usageProvider(props.account)}>
            {(provider) => <span style={{ fg: fg(theme.text.muted), dim: props.greyed }}> · {provider()}</span>}
          </Show>
        </text>
        <Index each={props.tags}>
          {(tag) => (
            <text flexShrink={0} fg={tagColor(tag().tone)} attributes={props.greyed ? TextAttributes.DIM : 0}>
              {` · ${tag().text}`}
            </text>
          )}
        </Index>
      </box>
      <Show
        when={props.account.windows.length > 0}
        fallback={
          <text fg={fg(theme.text.muted)} attributes={props.greyed ? TextAttributes.DIM : 0}>
            No quota reading yet.
          </text>
        }
      >
        <Index each={props.account.windows}>
          {(window) => {
            // Its text changes once a minute, though the clock it reads ticks every second.
            const meter = createMemo(() => usageMeter(window(), labelWidth(), props.width, props.at), undefined, {
              equals: (a: UsageMeter, b: UsageMeter) => a.tone === b.tone && usageLine(a) === usageLine(b),
            })
            return (
              <text wrapMode="none">
                <span style={{ fg: fg(theme.text.muted), dim: props.greyed }}>{meter().label} </span>
                <span style={{ fg: barColor(meter().tone), dim: props.greyed }}>{meter().filled}</span>
                <span style={{ fg: fg(theme.text.muted), dim: props.greyed }}>{meter().empty}</span>
                <span style={{ fg: fg(theme.text.base), dim: props.greyed }}> {meter().percent}</span>
                <span style={{ fg: fg(theme.text.muted), dim: props.greyed }}> {meter().tail}</span>
              </text>
            )
          }}
        </Index>
      </Show>
    </box>
  )
}
