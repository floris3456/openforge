export * as ImageFit from "./fit.js"

import type { SessionRunnerModel } from "../session/runner/model.js"
import { ImageRuler } from "./ruler.js"

// Optimized images (spec images): what each model reads, and an image fitted to it once, the same bytes every time.
// A model without an entry keeps today's handling.

export interface Model {
  /** The protocol its requests use; its limits hold there. */
  readonly protocol: string
  /** Long edge and visual tokens ({@link tokens}) the model reads without downscaling. */
  readonly edge: number
  readonly tokens: number
  /** How it counts an image's visual tokens ({@link tokens}). */
  readonly grid: Grid
  /** Images and base64 bytes one request carries at most. */
  readonly count: number
  readonly bytes: number
  /** Base64 bytes per image at most. */
  readonly imageBytes: number
  /** Base64 bytes per visual token at most: an image's share of `bytes`, and so its quality. */
  readonly bytesPerToken: number
  /** How `image.show` zooms for it: enlarged with the ruler ({@link zoom}, spec image-zoom); without it, as {@link crop} does. */
  readonly zoom?: Zoom
}

/** The enlarging zoom with the token-grid ruler (spec image-zoom). */
export interface Zoom {
  /** The largest whole factor a region is enlarged by. */
  readonly enlarge: number
  /** The zoom image's long and short edge at most, besides the model's own limits. */
  readonly box: { readonly long: number; readonly short: number }
  /** The ruler's margin along the picture's top and left, in the model's token cells. */
  readonly margin: { readonly top: number; readonly left: number }
}

/** ⌈h/cell⌉ × (⌈w/cell⌉ + row) + image tokens; an image of fewer than `least` pixels is first scaled up to that area. */
export interface Grid {
  readonly cell: number
  readonly row: number
  readonly image: number
  readonly least: number
}

export const MODELS: Readonly<Record<string, Model>> = {
  // Anthropic's Vision docs: 2,576 px and 4,784 visual tokens of 28 px; 600 images and 128 MB a request, 10 MB an
  // image. 120 bytes a token keep a 1M context of images at 120 MB (spec images, Decided).
  "claude-opus-5-5": {
    protocol: "anthropic-messages",
    edge: 2_576,
    tokens: 4_784,
    grid: { cell: 28, row: 0, image: 0, least: 0 },
    count: 600,
    bytes: 120_000_000,
    imageBytes: 10_000_000,
    bytesPerToken: 120,
    // The owner, 2026-11-23: "we never send an image over to anthropic over 2576×1449"; the ruler's margin is 56 px on
    // the left and 28 px at the top (spec image-zoom).
    zoom: { enlarge: 4, box: { long: 2_576, short: 1_449 }, margin: { top: 1, left: 2 } },
  },
  // DeepSeek's Vision guide and its image token calculator (V4.1: 14-px patches merged 3×3, a token ending each row
  // and 2 an image, an image under 544×544 px scaled up to it): 1,024 tokens, about 1300×1300 px; 4,096 px a side once
  // a request holds 15 images; 600 images, 32 MiB an image. Served by Command Code, whose Provider API refuses a body
  // over 32 MiB, text and images together: 24 MiB of images leave 8 MiB for the rest (spec images, DeepSeek). 270
  // bytes a 42-px token are Opus's 120 a 28-px one, the same bytes a pixel.
  "deepseek-v4.1-flash": {
    protocol: "open-responses",
    edge: 4_096,
    tokens: 1_024,
    grid: { cell: 42, row: 1, image: 2, least: 544 * 544 },
    count: 600,
    bytes: 24 * 1024 * 1024,
    imageBytes: 32 * 1024 * 1024,
    bytesPerToken: 270,
  },
}

/**
 * The entry of a chat's model, when its route speaks the entry's protocol: by its ID, or the ID's last segment, so a
 * provider's prefix (`deepseek/deepseek-v4.1-flash` on CLIProxyPacer) names the same model.
 */
export const forModel = (model: Pick<SessionRunnerModel.Resolved, "model">) => {
  const id = model.model.id
  const entry = MODELS[id] ?? MODELS[id.split("/").at(-1) ?? id]
  return entry?.protocol === model.model.route.protocol ? entry : undefined
}

/**
 * Images and bytes one request carries; `OPENFORGE_TEST_IMAGE_LIMITS=<count>,<bytes>` lowers them for end-to-end tests
 * with the fake model. Not a setting.
 */
export const requestLimits = (model: Model) => {
  const test = process.env.OPENFORGE_TEST_IMAGE_LIMITS?.split(",").map(Number)
  if (test?.length === 2 && test.every((value) => Number.isInteger(value) && value > 0))
    return { count: test[0], bytes: test[1] }
  return { count: model.count, bytes: model.bytes }
}

export const available = typeof Bun !== "undefined" && typeof Bun.Image === "function"
// The same bytes on macOS and Linux: Bun's own codecs and geometry, not the system's.
if (available) Bun.Image.backend = "bun"

/** The visual tokens the model counts for an image of this size, by its {@link Grid}. */
export const tokens = (width: number, height: number, model: Model) => {
  const grid = model.grid
  const up = width * height < grid.least ? Math.sqrt(grid.least / (width * height)) : 1
  const rows = Math.ceil(Math.trunc(height * up) / grid.cell)
  return rows * (Math.ceil(Math.trunc(width * up) / grid.cell) + grid.row) + grid.image
}

/** The largest aspect-preserving size the model reads without downscaling; never larger than the image. */
export const fit = (width: number, height: number, model: Model) => {
  const size = (scale: number) => ({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  })
  const top = Math.min(1, model.edge / Math.max(width, height))
  const largest = size(top)
  if (tokens(largest.width, largest.height, model) <= model.tokens) return largest
  // Bisect the scale: the token count only grows with it.
  const search = (low: number, high: number, steps: number): number => {
    if (steps === 0) return low
    const middle = (low + high) / 2
    const candidate = size(middle)
    return tokens(candidate.width, candidate.height, model) <= model.tokens
      ? search(middle, high, steps - 1)
      : search(low, middle, steps - 1)
  }
  return size(search(0, top, 40))
}

/** How an image of this size is shown: at full resolution, or scaled to fit. */
export const shownAs = (width: number, height: number, model: Model) => {
  const shown = fit(width, height, model)
  if (shown.width === width && shown.height === height) return "shown at full resolution"
  return `scaled to ${shown.width}×${shown.height} (${(shown.width / width).toFixed(2)}×)`
}

const QUALITIES = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30]
const KEEPABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4

export interface Fitted {
  readonly width: number
  readonly height: number
  readonly shown: { readonly width: number; readonly height: number }
  readonly mime: string
  readonly data: Uint8Array
}

/**
 * Sizes an image to {@link fit} and encodes it as WebP at the highest quality (95 down by 5) within the model's base64
 * bytes per visual token and per image; keeps the image as it came when it already fits both and is smaller. The same
 * image always gives the same bytes. Undefined when it can't be decoded.
 */
export const convert = async (source: Uint8Array, mime: string, model: Model): Promise<Fitted | undefined> => {
  const meta = await new Bun.Image(source).metadata().catch(() => undefined)
  if (!meta) return undefined
  const shown = fit(meta.width, meta.height, model)
  const cap = Math.min(model.bytesPerToken * tokens(shown.width, shown.height, model), model.imageBytes)
  const encode = (quality: number) =>
    new Bun.Image(source).resize(shown.width, shown.height, { filter: "lanczos3" }).webp({ quality }).bytes()
  const pick = async (index: number): Promise<Uint8Array> => {
    const encoded = await encode(QUALITIES[index])
    if (base64Length(encoded.length) <= cap || index === QUALITIES.length - 1) return encoded
    return pick(index + 1)
  }
  const webp = await pick(0).catch(() => undefined)
  if (!webp) return undefined
  const keep =
    KEEPABLE.has(mime) &&
    shown.width === meta.width &&
    shown.height === meta.height &&
    base64Length(source.length) <= cap &&
    source.length < webp.length
  return { width: meta.width, height: meta.height, shown, mime: keep ? mime : "image/webp", data: keep ? source : webp }
}

export interface Region {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Cuts `region`, in the pixels of the image as shown, out of the original at full resolution, as PNG. The region maps
 * to the original's pixels by the scale it was shown at; one outside the image, or empty, is refused with the reason.
 */
export const crop = async (source: Uint8Array, region: Region, model: Model) => {
  const placed = await place(source, region, model)
  if (typeof placed === "string") return placed
  const original = placed.original
  const opened = await open(source, placed.format)
  const cut = opened.photon.crop(
    opened.image,
    original.left,
    original.top,
    original.left + original.width,
    original.top + original.height,
  )
  const bytes = cut.get_bytes()
  opened.image.free()
  cut.free()
  return { bytes, shown: placed.shown, original }
}

/**
 * The enlarging zoom (spec image-zoom): `region`, in the pixels of the image as shown, cut out of the original at full
 * resolution and enlarged with Lanczos3 by the largest whole factor from `settings.enlarge` down to 2 at which it fits the
 * zoom's box and the model's limits with the ruler's margin, else shown at its own resolution, and the ruler drawn
 * around it ({@link ImageRuler}), as PNG. Never shrunk: a region too large at its own resolution is refused with the
 * largest region of its shape that fits, in pixels as shown. One outside the image, or empty, is refused as by
 * {@link crop}.
 */
export const zoom = async (source: Uint8Array, region: Region, model: Model, settings: Zoom) => {
  const placed = await place(source, region, model)
  if (typeof placed === "string") return placed
  const original = placed.original
  const margin = { top: settings.margin.top * model.grid.cell, left: settings.margin.left * model.grid.cell }
  const fits = (width: number, height: number) => within(margin.left + width, margin.top + height, model, settings)
  if (!fits(original.width, original.height)) {
    const largest = largestShown(region, placed.scale, placed.size, fits)
    return `The zoom shows a region at its own resolution or enlarged, never smaller: this one, ${original.width}×${original.height} pixels of the original, is too large with its ruler. The largest region of its shape that fits is ${largest.width}×${largest.height} pixels of the image as shown.`
  }
  const factor =
    Array.from({ length: Math.max(0, settings.enlarge - 1) }, (_, index) => settings.enlarge - index).find((factor) =>
      fits(original.width * factor, original.height * factor),
    ) ?? 1
  const size = { width: original.width * factor, height: original.height * factor }
  const opened = await open(source, placed.format)
  const photon = opened.photon
  const cut = photon.crop(opened.image, original.left, original.top, original.left + original.width, original.top + original.height)
  const scaled = factor === 1 ? cut : photon.resize(cut, size.width, size.height, photon.SamplingFilter.Lanczos3)
  const ruled = ImageRuler.draw(photon, scaled, original, margin, model.grid.cell)
  const bytes = ruled.image.get_bytes()
  new Set([opened.image, cut, scaled, ruled.image]).forEach((item) => item.free())
  return { bytes, shown: placed.shown, original, factor, size, margin, ticks: ruled.ticks }
}

/** Where `region`, in pixels of the image as shown, lies in the original; the reason when it is outside or empty. */
const place = async (source: Uint8Array, region: Region, model: Model) => {
  const meta = await new Bun.Image(source).metadata()
  const shown = fit(meta.width, meta.height, model)
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > shown.width ||
    region.y + region.height > shown.height
  )
    return `The zoom must lie within the image as shown, ${shown.width}×${shown.height} pixels.`
  const scale = { x: meta.width / shown.width, y: meta.height / shown.height }
  const left = Math.floor(region.x * scale.x)
  const top = Math.floor(region.y * scale.y)
  const right = Math.min(meta.width, Math.ceil((region.x + region.width) * scale.x))
  const bottom = Math.min(meta.height, Math.ceil((region.y + region.height) * scale.y))
  return {
    format: meta.format,
    size: { width: meta.width, height: meta.height },
    shown,
    scale,
    original: { left, top, width: right - left, height: bottom - top },
  }
}

// Photon reads no EXIF orientation, so a JPEG is first turned the way it is shown, losslessly.
const open = async (source: Uint8Array, format: string) => {
  const upright = format === "jpeg" ? await new Bun.Image(source).png({ compressionLevel: 1 }).bytes() : source
  const { PhotonNormalize } = await import("./photon-normalize.js")
  const photon = await PhotonNormalize.load()
  return { photon, image: photon.PhotonImage.new_from_byteslice(upright) }
}

/** Whether an image of this size is within the zoom's box and what the model reads without downscaling it. */
const within = (width: number, height: number, model: Model, zoom: Zoom) => {
  const read = fit(width, height, model)
  return (
    Math.max(width, height) <= zoom.box.long &&
    Math.min(width, height) <= zoom.box.short &&
    read.width === width &&
    read.height === height
  )
}

// The largest region of `region`'s shape, in pixels as shown, that fits wherever it is placed: a shown region covers
// at most one original pixel more than its size times the scale. By bisection over its scale.
const largestShown = (
  region: Region,
  scale: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  fits: (width: number, height: number) => boolean,
) => {
  const shape = (part: number) => ({
    width: Math.max(1, Math.floor(region.width * part)),
    height: Math.max(1, Math.floor(region.height * part)),
  })
  const holds = (part: number) => {
    const shown = shape(part)
    return fits(
      Math.min(size.width, Math.ceil(shown.width * scale.x) + 1),
      Math.min(size.height, Math.ceil(shown.height * scale.y) + 1),
    )
  }
  const search = (low: number, high: number, steps: number): number => {
    if (steps === 0) return low
    const middle = (low + high) / 2
    return holds(middle) ? search(middle, high, steps - 1) : search(low, middle, steps - 1)
  }
  return shape(search(0, 1, 40))
}

/**
 * The visual tokens the model counts for an image ({@link tokens}) at the size it reads it at, from the image's
 * header. Undefined when the header can't be read.
 */
export const visualTokens = (base64: string, model: Model) => {
  const size = dimensions(base64)
  if (!size) return undefined
  const shown = fit(size.width, size.height, model)
  return tokens(shown.width, shown.height, model)
}

// Decodes only the bytes a header needs: base64 in whole 4-character groups around the wanted range.
const bytesAt = (base64: string, start: number, length: number) => {
  const from = Math.floor(start / 3) * 4
  const decoded = Buffer.from(base64.slice(from, from + Math.ceil((length + 3) / 3) * 4), "base64")
  return decoded.subarray(start % 3, (start % 3) + length)
}

const dimensions = (base64: string): { width: number; height: number } | undefined => {
  const head = bytesAt(base64, 0, 32)
  if (head.length < 24) return undefined
  // PNG: IHDR width and height.
  if (head[0] === 0x89 && head[1] === 0x50) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  // GIF: logical screen size.
  if (head.toString("latin1", 0, 3) === "GIF") return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    const chunk = head.toString("latin1", 12, 16)
    if (chunk === "VP8 ") {
      const frame = bytesAt(base64, 26, 4)
      return { width: frame.readUInt16LE(0) & 0x3fff, height: frame.readUInt16LE(2) & 0x3fff }
    }
    if (chunk === "VP8L") {
      const bits = bytesAt(base64, 21, 4).readUInt32LE(0)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === "VP8X") {
      const canvas = bytesAt(base64, 24, 6)
      return { width: canvas.readUIntLE(0, 3) + 1, height: canvas.readUIntLE(3, 3) + 1 }
    }
    return undefined
  }
  if (head[0] === 0xff && head[1] === 0xd8) return jpegDimensions(base64)
  return undefined
}

// Walks JPEG segments to the first start-of-frame, decoding only each segment's marker and length.
const jpegDimensions = (base64: string) => {
  const total = Math.floor((base64.length * 3) / 4)
  const walk = (offset: number, steps: number): { width: number; height: number } | undefined => {
    if (steps === 0 || offset + 9 > total) return undefined
    const segment = bytesAt(base64, offset, 9)
    if (segment[0] !== 0xff) return undefined
    const marker = segment[1]
    // Fill bytes and markers without a length.
    if (marker === 0xff) return walk(offset + 1, steps - 1)
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return walk(offset + 2, steps - 1)
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) return { width: segment.readUInt16BE(7), height: segment.readUInt16BE(5) }
    return walk(offset + 2 + segment.readUInt16BE(2), steps - 1)
  }
  return walk(0, 1_000)
}
