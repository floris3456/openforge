import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createMediaSource } from "../component/media-source"
import { useTheme } from "../context/theme"
import { dataBytes, fallbackLine, type ChatImage } from "./chat"

// openforge (spec image-view): an image's line in the chat, the model's or the fallback with the image's size.

/** An image's line in the chat, which opens the viewer when clicked. */
export function ChatImageLine(props: { image: ChatImage; onOpen: () => void }) {
  const theme = useTheme()
  const [hover, setHover] = createSignal(false)
  const size = createImageSize(() => (props.image.line === undefined ? props.image.uri : undefined))
  const text = createMemo(() => props.image.line ?? fallbackLine(props.image.name, size()))
  return (
    <text
      fg={hover() ? theme.text.action.secondary.hovered : theme.text.action.secondary.base}
      wrapMode="word"
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        props.onOpen()
      }}
    >
      {text()}
    </text>
  )
}

/** An image's size in pixels, read from its bytes; a `media:` ref reads them from the server once it shows. */
function createImageSize(uri: () => string | undefined) {
  const media = createMediaSource(() => uri() ?? "")
  const [size, setSize] = createSignal<{ width: number; height: number }>()
  createEffect(
    on(
      () => (uri() === undefined ? undefined : media.source()),
      (source) => {
        setSize(undefined)
        if (!source) return
        let active = true
        onCleanup(() => {
          active = false
        })
        const bytes = typeof source === "string" ? dataBytes(source) : source
        if (!bytes) return
        new Bun.Image(bytes).metadata().then(
          (meta) => {
            if (active) setSize({ width: meta.width, height: meta.height })
          },
          () => {},
        )
      },
    ),
  )
  return size
}
