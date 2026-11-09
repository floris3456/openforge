export * as ImageFit from "./fit.js"

import type { SessionRunnerModel } from "../session/runner/model.js"

// Optimized images (spec images): what each model reads, and an image fitted to it once, the same bytes every time.
// A model without an entry keeps today's handling.

export interface Model {
  /** The protocol its requests use; its limits hold there. */
  readonly protocol: string
  /** Long edge and visual tokens (⌈w/28⌉ × ⌈h/28⌉) the model reads without downscaling. */
  readonly edge: number
  readonly tokens: number
  /** Images and base64 bytes one request carries at most. */
  readonly count: number
  readonly bytes: number
  /** Base64 bytes per image at most. */
  readonly imageBytes: number
  /** Base64 bytes per visual token at most, so a context full of images stays under `bytes`. */
  readonly bytesPerToken: number
}

export const MODELS: Readonly<Record<string, Model>> = {
  // Anthropic's Vision docs: 2,576 px and 4,784 visual tokens; 600 images and 128 MB a request, 10 MB an image. 120
  // bytes a token keep a 1M context of images at 120 MB (spec images, Decided).
  "claude-opus-5-5": {
    protocol: "anthropic-messages",
    edge: 2_576,
    tokens: 4_784,
    count: 600,
    bytes: 120_000_000,
    imageBytes: 10_000_000,
    bytesPerToken: 120,
  },
}

/** The entry of a chat's model, when its route speaks the entry's protocol. */
export const forModel = (model: Pick<SessionRunnerModel.Resolved, "model">) => {
  const entry = MODELS[model.model.id]
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

export const tokens = (width: number, height: number) => Math.ceil(width / 28) * Math.ceil(height / 28)

/** The largest aspect-preserving size the model reads without downscaling; never larger than the image. */
export const fit = (width: number, height: number, model: Model) => {
  const size = (scale: number) => ({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  })
  const top = Math.min(1, model.edge / Math.max(width, height))
  const largest = size(top)
  if (tokens(largest.width, largest.height) <= model.tokens) return largest
  // Bisect the scale: the token count only grows with it.
  const search = (low: number, high: number, steps: number): number => {
    if (steps === 0) return low
    const middle = (low + high) / 2
    const candidate = size(middle)
    return tokens(candidate.width, candidate.height) <= model.tokens
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
  const cap = Math.min(model.bytesPerToken * tokens(shown.width, shown.height), model.imageBytes)
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
  // Photon reads no EXIF orientation, so a JPEG is first turned the way it is shown, losslessly.
  const upright = meta.format === "jpeg" ? await new Bun.Image(source).png({ compressionLevel: 1 }).bytes() : source
  const { PhotonNormalize } = await import("./photon-normalize.js")
  const photon = await PhotonNormalize.load()
  const image = photon.PhotonImage.new_from_byteslice(upright)
  const cut = photon.crop(image, left, top, right, bottom)
  const bytes = cut.get_bytes()
  image.free()
  cut.free()
  return { bytes, shown, original: { left, top, width: right - left, height: bottom - top } }
}

/**
 * The visual tokens the model counts for an image: ⌈w/28⌉ × ⌈h/28⌉ of the size it reads it at, from the image's
 * header. Undefined when the header can't be read.
 */
export const visualTokens = (base64: string, model: Model) => {
  const size = dimensions(base64)
  if (!size) return undefined
  const shown = fit(size.width, size.height, model)
  return tokens(shown.width, shown.height)
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
