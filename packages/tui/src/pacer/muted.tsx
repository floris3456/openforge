import { createMemo, createSignal } from "solid-js"
import { useConfig } from "../config"
import { usePacer } from "../context/pacer"
import { useTheme } from "../context/theme"
import { DIALOG_LIST_INSET } from "../ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { providerName } from "./format"

// Muted models (spec cliproxypacer-cache-notices, section 4): a provider's model whose cache losses the provider caused
// show no card, kept in this TUI's config (`cliproxypacer.notices.muted`). A key in the Requests tab mutes the model of
// the request under it, and Settings › CLIProxyPacer › Muted models lists the muted ones beside every model CLIProxyPacer
// serves. A loss openforge, CLIProxyPacer or the chat caused still shows, and the Requests tab still lists every request.

export interface MutedModel {
  /** The provider of the account that served it, as CLIProxyPacer names it: `commandcode`. */
  readonly provider: string
  readonly model: string
}

/**
 * CLIProxyPacer's causes of a loss the provider caused: nothing sent changed, yet it didn't reuse its cache, or
 * CLIProxyPacer couldn't tell why. A loss without a cause counts too; every other cause is openforge's, CLIProxyPacer's
 * or the chat's (a changed prompt, another account or model, a longer cache).
 */
const PROVIDER_CAUSES: ReadonlySet<string> = new Set(["provider", "unknown"])

/** Whether a loss of this cause (`Notice.causeCode`) is the provider's, which muting its model hides. */
export function providerCaused(causeCode: string | undefined) {
  return causeCode === undefined || PROVIDER_CAUSES.has(causeCode)
}

/**
 * Whether the provider's model is muted; names compare in any case. One without a provider is never muted: a request
 * CLIProxyPacer refused before choosing an account, or a notice of a service from before notices named the provider.
 */
export function isMuted(muted: readonly MutedModel[], pair: MutedModel) {
  return Boolean(pair.provider) && muted.some((item) => same(item, pair))
}

/** The list with the provider's model muted, or unmuted when it was. */
export function toggleMuted(muted: readonly MutedModel[], pair: MutedModel) {
  if (isMuted(muted, pair)) return muted.filter((item) => !same(item, pair))
  return [...muted, { provider: pair.provider.toLowerCase(), model: pair.model }]
}

/** `Command Code deepseek-v4.1-flash`. */
export function mutedName(pair: MutedModel) {
  return `${providerName(pair.provider)} ${pair.model}`
}

/** What the Settings row shows: `none`, the one model, or how many. */
export function mutedSummary(muted: readonly MutedModel[]) {
  if (muted.length === 0) return "none"
  if (muted.length === 1) return mutedName(muted[0]!)
  return `${muted.length} models`
}

const same = (a: MutedModel, b: MutedModel) =>
  a.provider.toLowerCase() === b.provider.toLowerCase() && a.model.toLowerCase() === b.model.toLowerCase()

/**
 * This TUI's muted models, and muting or unmuting one in its config. With `say`, a toast says what it did, for a key
 * pressed where the list doesn't show.
 */
export function useMuted() {
  const config = useConfig()
  const toast = useToast()
  const list = (): readonly MutedModel[] => config.data.cliproxypacer?.notices?.muted ?? []
  const toggle = (pair: MutedModel, say = false) => {
    const muting = !isMuted(list(), pair)
    return config
      .update((draft) => {
        draft.cliproxypacer ??= {}
        draft.cliproxypacer.notices ??= {}
        draft.cliproxypacer.notices.muted = toggleMuted(draft.cliproxypacer.notices.muted ?? [], pair)
      })
      .then(() => {
        if (!say) return
        toast.show({
          variant: "info",
          message: muting
            ? `Muted ${mutedName(pair)}: a cache miss the provider caused shows no card`
            : `Unmuted ${mutedName(pair)}: its cache misses show a card again`,
        })
      })
      .catch(toast.error)
  }
  return { list, muted: (pair: MutedModel) => isMuted(list(), pair), toggle }
}

/**
 * Settings › CLIProxyPacer › Muted models: the muted models first, then every model CLIProxyPacer serves under its
 * provider, a muted one marked. Enter mutes or unmutes the one selected; `onClose` goes back to Settings.
 */
export function DialogMuted(props: { onClose: () => void }) {
  const pacer = usePacer()
  const muted = useMuted()
  const theme = useTheme().surface("dialog")
  const key = (pair: MutedModel) => `${pair.provider.toLowerCase()}\n${pair.model}`
  const served = createMemo(() =>
    (pacer?.models()?.value.items ?? [])
      .flatMap((model) => model.providers.map((provider) => ({ provider, model: model.id })))
      .toSorted(
        (a, b) => providerName(a.provider).localeCompare(providerName(b.provider)) || a.model.localeCompare(b.model),
      ),
  )
  const options = createMemo(() => [
    ...muted.list().map((pair) => ({
      title: mutedName(pair),
      category: "Muted",
      value: { pair, place: `muted\n${key(pair)}` },
      footer: "muted",
      footerColor: theme.text.feedback.warning.base,
    })),
    ...served().map((pair) => ({
      title: pair.model,
      category: providerName(pair.provider),
      value: { pair, place: key(pair) },
      footer: muted.muted(pair) ? "muted" : "",
      footerColor: theme.text.feedback.warning.base,
    })),
  ])
  const [ref, setRef] = createSignal<DialogSelectRef<{ pair: MutedModel; place: string }>>()
  const selected = () => ref()?.selected?.value.pair
  return (
    <DialogSelect
      title="Muted models"
      options={options()}
      preserveSelection
      ref={setRef}
      onSelect={(option) => void muted.toggle(option.value.pair)}
      onCancel={props.onClose}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={theme.text.muted}>None muted, and CLIProxyPacer lists no models</text>
        </box>
      }
      footerHints={[
        { title: selected() && muted.muted(selected()!) ? "unmute" : "mute", label: "enter", group: "primary" },
      ]}
    />
  )
}
