export * as ImageRuler from "./ruler.js"

import type { PhotonNormalize } from "./photon-normalize.js"

// The owner's ruler around a zoom (spec image-zoom): a dark margin along the picture's top and left, each a whole
// number of the model's token cells, so the picture begins on a cell border of the zoom image; a tick in every cell of
// the zoom image, on the centre of the original pixel that the cell's first border falls in, and every 4th labelled
// with that pixel. Labels keep one size in output pixels whatever the zoom's factor, so they stay legible to the model.

type Image = InstanceType<PhotonNormalize.Photon["PhotonImage"]>

/** Label size in output pixels. photon draws Roboto, whose digits are about 0.49 of this wide and 0.67 tall. */
export const FONT = 18
/** Every how many ticks one is labelled. */
export const EVERY = 4

export interface Margin {
  readonly top: number
  readonly left: number
}

export interface Region {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface Tick {
  readonly axis: "x" | "y"
  /** The original pixel on whose centre it is. */
  readonly value: number
  /** Its centre in the zoom image, from the left (x) or top (y) edge of the whole image. */
  readonly at: number
  /** Every 4th, from the picture's top-left: a longer tick. */
  readonly major: boolean
  /** A major tick whose label stays within the picture's side. */
  readonly labelled: boolean
}

const TICK = { major: 9, minor: 6 }
// 2 px wide, anti-aliased, so a tick's centre is exact at any factor.
const THICKNESS = 2
const GAP = 3
const LABEL_HEIGHT = Math.ceil(FONT * 0.67)
// Where photon's ink starts below the y it is given, and how far down it reaches.
const INK_TOP = Math.round(FONT * 0.17)
const INK_BOTTOM = Math.round(FONT * 0.78)
const BACKGROUND = [24, 24, 24, 255]
const WHITE = [255, 255, 255]

/**
 * Draws the ruler around `picture`, which is `region` of the original (in the original's pixels) at the picture's size,
 * in `margin` (in pixels) along its top and left; `cell` is the model's token cell in pixels. Returns a new image, the
 * picture's pixels unchanged inside it, and the ticks drawn.
 */
export const draw = (photon: PhotonNormalize.Photon, picture: Image, region: Region, margin: Margin, cell: number) => {
  const width = picture.get_width()
  const height = picture.get_height()
  const scale = { x: width / region.width, y: height / region.height }
  const canvas = { width: margin.left + width, height: margin.top + height }
  const pixels = new Uint8Array(canvas.width * canvas.height * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset)
  const source = picture.get_raw_pixels()
  for (let row = 0; row < height; row++)
    pixels.set(
      source.subarray(row * width * 4, (row + 1) * width * 4),
      ((margin.top + row) * canvas.width + margin.left) * 4,
    )
  const ticks = [
    ...grid("x", region.left, width, scale.x, margin.left, cell),
    ...grid("y", region.top, height, scale.y, margin.top, cell),
  ]
  const blend = (column: number, row: number, alpha: number) => {
    if (column < 0 || row < 0 || column >= canvas.width || row >= canvas.height) return
    const offset = (row * canvas.width + column) * 4
    for (let channel = 0; channel < 3; channel++)
      pixels[offset + channel] = Math.round(pixels[offset + channel] * (1 - alpha) + WHITE[channel] * alpha)
  }
  for (const tick of ticks)
    for (let line = Math.floor(tick.at - THICKNESS / 2); line < Math.ceil(tick.at + THICKNESS / 2); line++) {
      const coverage = Math.min(line + 1, tick.at + THICKNESS / 2) - Math.max(line, tick.at - THICKNESS / 2)
      for (let step = 0; step < (tick.major ? TICK.major : TICK.minor); step++) {
        if (tick.axis === "x") blend(line, margin.top - 1 - step, coverage)
        if (tick.axis === "y") blend(margin.left - 1 - step, line, coverage)
      }
    }
  const image = new photon.PhotonImage(pixels, canvas.width, canvas.height)
  const top = margin.top - TICK.major - GAP - INK_BOTTOM - 1
  for (const tick of ticks.filter((tick) => tick.labelled)) {
    const text = String(tick.value)
    const textWidth = labelWidth(text)
    if (tick.axis === "x") photon.draw_text(image, text, Math.round(tick.at - textWidth / 2), top, FONT)
    if (tick.axis === "y")
      photon.draw_text(
        image,
        text,
        margin.left - TICK.major - GAP - textWidth,
        Math.round(tick.at - (INK_TOP + INK_BOTTOM) / 2),
        FONT,
      )
  }
  // The factor in the top-left corner: `4×`.
  photon.draw_text(image, `${scale.x}×`, 4, top, FONT)
  return { image, ticks }
}

/**
 * What a zoom's result text says about its ruler: where the picture begins inside the image (the margin), that the
 * labels give the original's pixel coordinates with a pixel's centre at its index, and to read positions off them.
 */
export const note = (margin: Margin, cell: number) =>
  `Rulers in a dark margin around the picture, labelled along its top and left: the picture begins ${margin.left} px from this image's left edge and ${margin.top} px from its top. The labels give the original image's pixel coordinates, a pixel's centre at its index (a tick in every ${cell}-px block of this image, every ${EVERY}th labelled, each tick on the centre of the pixel it names). Read positions off the labels.`

const labelWidth = (text: string) => Math.ceil(text.length * FONT * 0.49)

// A tick in every cell of the picture from its top-left, which the margin puts on a cell border of the zoom image: on
// the centre of the original pixel the cell's first border falls in, so it names that pixel. Every 4th labelled, when
// its label stays within the picture's side.
const grid = (axis: "x" | "y", origin: number, size: number, scale: number, offset: number, cell: number) =>
  Array.from({ length: Math.ceil(size / cell) }, (_, index): Tick => {
    const value = origin + Math.floor((index * cell) / scale + 1e-9)
    const at = offset + (value - origin + 0.5) * scale
    const reach = (axis === "x" ? labelWidth(String(value)) : LABEL_HEIGHT) / 2
    const major = index % EVERY === 0
    return { axis, value, at, major, labelled: major && at - reach >= offset && at + reach <= offset + size }
  })
