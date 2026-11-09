import type { BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Index, Show } from "solid-js"
import { useData } from "../context/data"
import { usePacer, type Pacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import { chatAccount, usageAccounts, usageSection, type UsageSpan } from "./format"

// The sidebar's Usage section (spec cliproxypacer-usage-meters), where Context was: for the model picked for the chat
// now, as the prompt shows it, the accounts of the provider serving it that serve it, one group per provider and plan,
// one row per account without its name, each window a strip whose fill is what is left, with the percent left and the
// time to its reset on it; the chat's account and where it moves marked, with a legend on the title line. Greyed with
// "as of" while CPP is unreachable, "no pacer" on a plain proxy, hidden while the model picked is another provider's
// and when no CPP is set up.

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
  // Frozen at the first frame it is stale, as the toolbar's item is.
  const asOf = createMemo<number | undefined>((previous) => {
    if (shown().length === 0) return undefined
    const chat = view()
    if (!(props.pacer.stale(props.pacer.accounts()) || (chat !== undefined && props.pacer.stale(chat))))
      return undefined
    return previous ?? props.pacer.status()?.asOf ?? props.pacer.accounts()?.value.asOf
  })
  props.pacer.countdown(
    () =>
      asOf() === undefined &&
      shown().some((account) =>
        account.windows.some((window) => window.resetsAt !== undefined || window.staleAt !== undefined),
      ),
  )
  const running = () => data.session.status(props.sessionID) === "running"
  // The clock ticks every second, the text changes once a minute: a line whose text, colors and backgrounds stand keeps
  // its object, so it isn't drawn again.
  const lines = createMemo<UsageSpan[][]>(
    (previous) =>
      usageSection({
        accounts: shown(),
        model: props.model ?? "",
        serving: serving(),
        chat: usage().chat,
        running: running(),
        width: width(),
        now: asOf() ?? props.pacer.now(),
        asOf: asOf(),
        noPacer: noPacer(),
      }).map((line, index) => {
        const old = previous[index]
        return old !== undefined && sameLine(old, line) ? old : line
      }),
    [],
  )
  const fg = (span: UsageSpan) => {
    if (span.ink === "base") return theme.text.base
    if (span.ink === "muted") return theme.text.muted
    if (span.ink === "faint") return theme.text.faint
    return theme.text.feedback[span.ink].base
  }
  const bg = (span: UsageSpan) => {
    if (span.background === undefined) return undefined
    const meter = theme.background.meter
    return (span.alternate ? meter.alternate : meter)[span.background]
  }

  return (
    <Show when={active() && (noPacer() || shown().length > 0)}>
      <box
        onSizeChange={function (this: BoxRenderable) {
          setWidth(this.width)
        }}
      >
        <Index each={lines()}>
          {(line) => (
            <text wrapMode="none">
              <Index each={line()}>
                {(span) => (
                  <span
                    style={{
                      fg: fg(span()),
                      bg: bg(span()),
                      bold: span().bold === true,
                      dim: span().dim === true,
                    }}
                  >
                    {span().text}
                  </span>
                )}
              </Index>
            </text>
          )}
        </Index>
      </box>
    </Show>
  )
}

function sameLine(a: readonly UsageSpan[], b: readonly UsageSpan[]) {
  return (
    a.length === b.length &&
    a.every((span, index) => {
      const other = b[index]!
      return (
        span.text === other.text &&
        span.ink === other.ink &&
        span.bold === other.bold &&
        span.dim === other.dim &&
        span.background === other.background &&
        span.alternate === other.alternate
      )
    })
  )
}
