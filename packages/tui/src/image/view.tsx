import { NativeImage, RGBA, type BoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from "solid-js"
import { promisify } from "node:util"
import { deflate } from "node:zlib"
import { cells, LIMIT, randomNumber } from "./placeholder"
import { useImageTerminal, type Cell, type Shown } from "./terminal"

// openforge (spec image-view): one image in a box of cells. With placeholders (inside tmux, see ./terminal) the image is
// fitted here to the box's pixels and drawn as placeholder cells; elsewhere OpenTUI's <image> draws it.

export type ImageSource = string | Uint8Array | NativeImage

/**
 * `fit` fits the image to the box with its aspect ratio kept, `cover` fills the box and cuts what is over, and
 * `actual` shows it at one image pixel per screen pixel from `offset` (the first column and row shown).
 */
export type ImageFit = "fit" | "cover" | "actual"

const pack = promisify(deflate)

export function ImageView(props: {
  id?: string
  source: ImageSource | undefined
  fit: ImageFit
  width: number | "100%"
  height: number | "100%"
  offset?: { readonly x: number; readonly y: number }
  flexShrink?: number
  flexBasis?: number
  onLoad?: (image: { width: number; height: number }) => void
  onError?: () => void
}) {
  const terminal = useImageTerminal()
  return (
    <Show
      when={terminal.placeholders || props.fit === "actual"}
      fallback={
        <image
          id={props.id}
          source={props.source}
          fit={props.fit === "cover" ? "cover" : "fit"}
          protocol="auto"
          width={props.width}
          height={props.height}
          flexShrink={props.flexShrink}
          flexBasis={props.flexBasis}
          onLoad={(image) => props.onLoad?.(image)}
          onError={() => props.onError?.()}
        />
      }
    >
      <Decoded {...props} />
    </Show>
  )
}

function Decoded(props: Parameters<typeof ImageView>[0]) {
  const terminal = useImageTerminal()
  const [image, setImage] = createSignal<NativeImage>()
  const [size, setSize] = createSignal({ width: 0, height: 0 })

  createEffect(
    on(
      () => props.source,
      (source) => {
        setImage(undefined)
        if (source === undefined) return
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
            props.onLoad?.({ width: result.width, height: result.height })
          },
          () => {
            if (active) props.onError?.()
          },
        )
      },
    ),
  )

  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexShrink={props.flexShrink}
      flexBasis={props.flexBasis}
      onSizeChange={function (this: BoxRenderable) {
        if (this.width !== size().width || this.height !== size().height)
          setSize({ width: this.width, height: this.height })
      }}
    >
      <Show when={image()}>
        {(decoded) => (
          <Show
            when={terminal.placeholders}
            fallback={<Region image={decoded()} size={size()} offset={props.offset} cell={terminal.cell()} />}
          >
            <Placed image={decoded()} size={size()} fit={props.fit} offset={props.offset} />
          </Show>
        )}
      </Show>
    </box>
  )
}

/** At actual size without placeholders: the part of the image the box shows, cut out and drawn by OpenTUI. */
function Region(props: {
  image: NativeImage
  size: { width: number; height: number }
  offset?: { readonly x: number; readonly y: number }
  cell: Cell
}) {
  const region = createMemo(() => {
    const x = Math.min(props.image.width - 1, Math.round((props.offset?.x ?? 0) * props.cell.width))
    const y = Math.min(props.image.height - 1, Math.round((props.offset?.y ?? 0) * props.cell.height))
    const width = Math.min(props.image.width - x, Math.round(props.size.width * props.cell.width))
    const height = Math.min(props.image.height - y, Math.round(props.size.height * props.cell.height))
    if (width <= 0 || height <= 0) return
    return {
      image: props.image.extract({ left: x, top: y, width, height }),
      columns: Math.max(1, Math.round(width / props.cell.width)),
      rows: Math.max(1, Math.round(height / props.cell.height)),
    }
  })
  createEffect(() => {
    const current = region()
    onCleanup(() => current?.image.dispose())
  })
  return (
    <Show when={region()}>
      {(current) => (
        <image source={current().image} fit="fit" protocol="auto" width={current().columns} height={current().rows} />
      )}
    </Show>
  )
}

/** With placeholders: the image fitted to the box's pixels, sent to the terminal, and drawn as placeholder cells. */
function Placed(props: {
  image: NativeImage
  size: { width: number; height: number }
  fit: ImageFit
  offset?: { readonly x: number; readonly y: number }
}) {
  const terminal = useImageTerminal()
  const number = randomNumber()
  const color = RGBA.fromIndex(number.index)
  const [placed, setPlaced] = createSignal<Shown>()
  onCleanup(() => terminal.hide(number))

  // Only what changes the pixels: the image, how it is fitted, the cell, and the box unless it is at actual size.
  const plan = createMemo(
    () => {
      const cell = terminal.cell()
      if (props.fit === "actual") return { image: props.image, fit: props.fit, cell, columns: 0, rows: 0 }
      const columns = Math.min(LIMIT, props.size.width)
      const rows = Math.min(LIMIT, props.size.height)
      if (columns <= 0 || rows <= 0) return
      return { image: props.image, fit: props.fit, cell, columns, rows }
    },
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (a !== undefined &&
          b !== undefined &&
          a.image === b.image &&
          a.fit === b.fit &&
          a.cell.width === b.cell.width &&
          a.cell.height === b.cell.height &&
          a.columns === b.columns &&
          a.rows === b.rows),
    },
  )

  createEffect(
    on(plan, (current) => {
      if (!current) return
      let active = true
      onCleanup(() => {
        active = false
      })
      const prepared = prepare(current.image, current.fit, current.cell, current.columns, current.rows)
      pack(prepared.rgba).then(
        (deflated) => {
          if (!active) return
          const shown = { pixels: { width: prepared.width, height: prepared.height, deflated }, ...prepared.placement }
          terminal.show(number, shown)
          setPlaced(shown)
        },
        () => {},
      )
    }),
  )

  // The placement's cells the box shows: all of them, or at actual size the window from the offset.
  const window = createMemo(() => {
    const current = placed()
    if (!current) return
    const columns = Math.min(current.columns, props.size.width)
    const rows = Math.min(current.rows, props.size.height)
    const x = props.fit === "actual" ? clamp(props.offset?.x ?? 0, 0, current.columns - columns) : 0
    const y = props.fit === "actual" ? clamp(props.offset?.y ?? 0, 0, current.rows - rows) : 0
    return { x, y, columns, rows }
  })
  const lines = createMemo(() => {
    const current = window()
    if (!current) return []
    return Array.from({ length: current.rows }, (_, row) =>
      cells(number, current.y + row, current.x, current.x + current.columns),
    )
  })

  return (
    <Index each={lines()}>
      {(line) => (
        <text fg={color} wrapMode="none" selectable={false} flexShrink={0}>
          {line()}
        </text>
      )}
    </Index>
  )
}

/**
 * The pixels the terminal gets for a placement, in RGBA rows without padding, always exactly the placement's pixels,
 * so the terminal draws them unscaled (it would fit a smaller image to the placement, and centre it by half a pixel,
 * which blurs it). `fit` is resized to the box and centred in it with transparent pixels, `cover` resized to fill it
 * and cut, and `actual` keeps every pixel and is padded with transparent ones to whole cells, so its placement shows
 * it at one image pixel per screen pixel.
 */
function prepare(image: NativeImage, fit: ImageFit, cell: Cell, columns: number, rows: number) {
  const owned: NativeImage[] = []
  const keep = (next: NativeImage) => (owned.push(next), next)
  const result = (() => {
    if (fit === "actual") {
      const placement = {
        columns: Math.min(LIMIT, Math.ceil(image.width / cell.width)),
        rows: Math.min(LIMIT, Math.ceil(image.height / cell.height)),
      }
      const width = Math.round(placement.columns * cell.width)
      const height = Math.round(placement.rows * cell.height)
      // An image of more cells than placeholders can number is shown smaller, as large as they reach.
      const scale = Math.min(1, width / image.width, height / image.height)
      const sized = scale < 1 ? keep(resize(image, scale)) : image
      return {
        image: keep(
          sized.extend({
            right: Math.max(0, width - sized.width),
            bottom: Math.max(0, height - sized.height),
            background: [0, 0, 0, 0],
          }),
        ),
        placement,
      }
    }
    const width = Math.round(columns * cell.width)
    const height = Math.round(rows * cell.height)
    const placement = { columns, rows }
    if (fit === "fit") {
      const scale = Math.min(width / image.width, height / image.height)
      const sized = scale === 1 ? image : keep(resize(image, scale))
      const left = Math.max(0, Math.floor((width - sized.width) / 2))
      const top = Math.max(0, Math.floor((height - sized.height) / 2))
      return {
        image: keep(
          sized.extend({
            left,
            top,
            right: Math.max(0, width - sized.width - left),
            bottom: Math.max(0, height - sized.height - top),
            background: [0, 0, 0, 0],
          }),
        ),
        placement,
      }
    }
    const scale = Math.max(width / image.width, height / image.height)
    const sized = keep(resize(image, scale))
    const cut = {
      left: Math.max(0, Math.floor((sized.width - width) / 2)),
      top: Math.max(0, Math.floor((sized.height - height) / 2)),
      width: Math.min(width, sized.width),
      height: Math.min(height, sized.height),
    }
    return { image: keep(sized.extract(cut)), placement }
  })()
  const rgba = new Uint8Array(result.image.width * result.image.height * 4)
  result.image.copyTo(rgba, { stride: result.image.width * 4, format: "rgba8" })
  const prepared = { rgba, width: result.image.width, height: result.image.height, placement: result.placement }
  owned.forEach((item) => item.dispose())
  return prepared
}

function resize(image: NativeImage, scale: number) {
  return image.resize({
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
    kernel: scale < 1 ? "area" : "catmull-rom",
  })
}

/** Decodes a source; a NativeImage is retained, so the caller may dispose its own. */
export async function decodeImage(source: ImageSource) {
  if (source instanceof NativeImage) return source.retain()
  if (typeof source === "string") return NativeImage.load(source)
  return NativeImage.decode(source)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.max(min, max), value))
}
