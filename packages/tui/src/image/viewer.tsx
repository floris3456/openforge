import type { BoxRenderable, NativeImage } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { createMediaSource } from "../component/media-source"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, useDialog } from "../ui/dialog"
import { fallbackLine } from "./chat"
import { useImageTerminal } from "./terminal"
import { decodeImage, ImageView } from "./view"

// openforge (spec image-view): the image viewer. It shows exactly the bytes it is given, with their line as its title:
// fitted to the window and never enlarged beyond its own pixels; Enter toggles actual size (one image pixel per screen
// pixel) when the image is larger than the window, where the arrows move around it; otherwise left and right go
// through the images in order. Esc closes it.

export type ViewerImage = {
  /** A `data:` URI or a `media:` ref. */
  readonly uri: string
  /** The line the model got before the image, its title; without one, its name and size are. */
  readonly line?: string
  readonly name?: string
}

export function DialogImage(props: { images: readonly ViewerImage[]; initial: number }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const terminal = useImageTerminal()
  const theme = useTheme().surface("dialog")
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const current = createMemo(() => props.images[index()]!)
  const media = createMediaSource(() => current().uri)
  const [image, setImage] = createSignal<NativeImage>()
  const [failed, setFailed] = createSignal(false)
  const [actual, setActual] = createSignal(false)
  const [offset, setOffset] = createSignal({ x: 0, y: 0 })
  const [area, setArea] = createSignal({ width: 0, height: 0 })

  const title = createMemo(() => {
    const decoded = image()
    return current().line ?? fallbackLine(current().name, decoded && { width: decoded.width, height: decoded.height })
  })

  dialog.setSize("full")
  dialog.setCentered(true)

  createEffect(
    on(
      () => [media.source(), media.failed()] as const,
      ([source, mediaFailed]) => {
        batch(() => {
          setImage(undefined)
          setFailed(mediaFailed)
        })
        if (source === undefined || mediaFailed) return
        let active = true
        let decoded: NativeImage | undefined
        onCleanup(() => {
          active = false
          decoded?.dispose()
        })
        decodeImage(source).then(
          (result) => {
            if (!active) return result.dispose()
            decoded = result
            setImage(result)
          },
          () => {
            if (active) setFailed(true)
          },
        )
      },
    ),
  )

  // The image's size in cells, and whether it is larger than the window.
  const natural = createMemo(() => {
    const decoded = image()
    if (!decoded) return
    const cell = terminal.cell()
    return { columns: decoded.width / cell.width, rows: decoded.height / cell.height }
  })
  const larger = createMemo(() => {
    const size = natural()
    return size !== undefined && (size.columns > area().width || size.rows > area().height)
  })
  const zoomed = () => actual() && larger()
  // The box the image takes: fitted, never larger than the image; or at actual size as much of it as the window holds.
  const box = createMemo(() => {
    const size = natural()
    if (!size || area().width <= 0 || area().height <= 0) return
    if (zoomed())
      return {
        width: Math.min(area().width, Math.ceil(size.columns)),
        height: Math.min(area().height, Math.ceil(size.rows)),
      }
    const scale = Math.min(1, area().width / size.columns, area().height / size.rows)
    return {
      width: Math.max(1, Math.floor(size.columns * scale)),
      height: Math.max(1, Math.floor(size.rows * scale)),
    }
  })

  function move(direction: number) {
    if (props.images.length < 2) return
    batch(() => {
      setIndex((value) => (value + direction + props.images.length) % props.images.length)
      setActual(false)
      setOffset({ x: 0, y: 0 })
    })
  }

  // At actual size an arrow moves a quarter of the window, up to the image's edge.
  function pan(x: number, y: number) {
    const size = natural()
    const shown = box()
    if (!size || !shown) return
    setOffset((value) => ({
      x: clamp(value.x + x * Math.max(1, Math.floor(shown.width / 4)), 0, Math.ceil(size.columns) - shown.width),
      y: clamp(value.y + y * Math.max(1, Math.floor(shown.height / 4)), 0, Math.ceil(size.rows) - shown.height),
    }))
  }

  function arrow(x: number, y: number) {
    if (zoomed()) return pan(x, y)
    if (x !== 0) move(x)
  }

  function toggle() {
    if (!larger()) return
    batch(() => {
      setActual((value) => !value)
      setOffset({ x: 0, y: 0 })
    })
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "left", title: "Previous image, or move left", group: "Dialog", run: () => arrow(-1, 0) },
      { bind: "right", title: "Next image, or move right", group: "Dialog", run: () => arrow(1, 0) },
      { bind: "up", title: "Move up", group: "Dialog", run: () => arrow(0, -1) },
      { bind: "down", title: "Move down", group: "Dialog", run: () => arrow(0, 1) },
      { bind: "return", title: "Actual size, or fitted", group: "Dialog", run: toggle },
    ],
  }))

  return (
    <box
      id="image-viewer"
      height={Math.max(4, dimensions().height - 1)}
      paddingLeft={3}
      paddingRight={3}
      paddingBottom={1}
      gap={1}
    >
      <DialogHeader title={title()} />
      <box
        flexGrow={1}
        minHeight={1}
        alignItems="center"
        justifyContent="center"
        onSizeChange={function (this: BoxRenderable) {
          if (this.width !== area().width || this.height !== area().height)
            setArea({ width: this.width, height: this.height })
        }}
      >
        <Show when={!failed()} fallback={<text fg={theme.text.feedback.error.base}>No preview</text>}>
          <Show when={box()}>
            {(size) => (
              <ImageView
                id="image-viewer-image"
                source={image()}
                fit={zoomed() ? "actual" : "fit"}
                width={size().width}
                height={size().height}
                offset={offset()}
                flexShrink={0}
                onError={() => setFailed(true)}
              />
            )}
          </Show>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="none">
          <Show when={props.images.length > 1}>
            <span style={{ fg: theme.text.base }}>←→</span> {zoomed() ? "move" : "images"} ·{" "}
          </Show>
          {index() + 1} of {props.images.length}
          <Show when={image()}>
            {(decoded) => (
              <>
                {" "}
                · {decoded().width}×{decoded().height}
              </>
            )}
          </Show>
        </text>
        <text fg={theme.text.muted} wrapMode="none" onMouseUp={toggle}>
          <Show when={larger()}>
            <span style={{ fg: theme.text.base }}>enter</span> {zoomed() ? "fit to window" : "actual size"}
          </Show>
        </text>
      </box>
    </box>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.max(min, max), value))
}
