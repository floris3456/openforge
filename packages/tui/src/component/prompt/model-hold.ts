import { createEffect, createSignal, onCleanup } from "solid-js"

/** As long as core waits for CLIProxyPacer's catalog before it runs a session on another model. */
export const HOLD_MS = 60_000

export type HeldModel = { providerID: string; modelID: string }

/**
 * A prompt sent on a named model whose provider has not listed its models yet: it stays in the composer, held, and
 * is sent once the model is listed. It is let go, back to a draft, when the text or the model changes, or by
 * `cancel` (Esc); `absent` is told when the provider's models come without it, or after {@link HOLD_MS}.
 */
export function createModelHold(input: {
  selection: () => HeldModel | undefined
  text: () => string
  available: (model: HeldModel) => boolean
  delivered: (model: HeldModel) => boolean
  absent: (model: HeldModel) => void
}) {
  const [held, setHeld] = createSignal<{ model: HeldModel; text: string; send: () => void }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const release = () => {
    clearTimeout(timer)
    timer = undefined
    setHeld(undefined)
  }
  onCleanup(() => clearTimeout(timer))

  createEffect(() => {
    const hold = held()
    if (!hold) return
    const selection = input.selection()
    if (!selection || !same(selection, hold.model) || input.text() !== hold.text) return release()
    if (input.available(hold.model)) {
      release()
      // Outside this effect, so that nothing the send reads is tracked by it.
      queueMicrotask(hold.send)
      return
    }
    if (!input.delivered(hold.model)) return
    release()
    input.absent(hold.model)
  })

  return {
    model: () => held()?.model,
    hold(model: HeldModel, send: () => void) {
      const current = held()
      if (current && same(current.model, model) && current.text === input.text()) return
      release()
      setHeld({ model: { providerID: model.providerID, modelID: model.modelID }, text: input.text(), send })
      timer = setTimeout(() => {
        release()
        input.absent(model)
      }, HOLD_MS)
    },
    cancel: release,
  }
}

function same(a: HeldModel, b: HeldModel) {
  return a.providerID === b.providerID && a.modelID === b.modelID
}
