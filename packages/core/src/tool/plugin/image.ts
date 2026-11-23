export * as ImageTool from "./image.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { optional } from "@opencode/schema/schema"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { ImageBank } from "../../image/bank.js"
import { ImageFit } from "../../image/fit.js"
import { ImageRuler } from "../../image/ruler.js"
import type { Tool } from "../../tool.js"
import { PictureRemoved } from "@opencode/util/picture-removed"

// The image bank's tool (spec images): `image.show` lists a chat's images, shows one again whole, or zooms into a region
// of its full-resolution original. Registered only while Settings › Session "Optimize images" is on; a Code Mode tool in
// the `image` group, beside opencode's `image.generate` (spec image-tools). What it shows is an image arriving like any
// other: numbered with its line, counted toward the limits. A model whose entry has `zoom` gets the enlarging zoom, with
// the owner's ruler when the entry has it, and a description of it with its own numbers (spec image-zoom).

const Pixels = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// A model's limits, from the table, so a description never changes between requests.
const limitsOf = (id: string, model: ImageFit.Model) => {
  const example = ImageFit.fit(16_000, 9_000, model)
  const square = ImageFit.fit(100_000, 100_000, model).width
  const grid = model.grid
  const columns = grid.row === 0 ? `⌈w/${grid.cell}⌉` : `(⌈w/${grid.cell}⌉+${grid.row})`
  const count = `${columns}×⌈h/${grid.cell}⌉${grid.image === 0 ? "" : `+${grid.image}`}`
  return `${id}: long edge ${model.edge.toLocaleString("en-US")} px and ${model.tokens.toLocaleString("en-US")} visual tokens, ${count}, about ${((square * square) / 1e6).toFixed(2)} MP, e.g. ${example.width}×${example.height}`
}

const fitted = (limits: string) =>
  `The region to show at full detail, in pixels of the image as shown. It is shown at its own resolution up to the model's limits (${limits}); a larger region is scaled down to fit. Omit it to show the whole image again.`

/** The zoom's description for a chat whose model has no entry: every entry's limits, as before spec image-zoom. */
export const ZOOM = fitted(
  Object.entries(ImageFit.MODELS)
    .map(([id, model]) => limitsOf(id, model))
    .join("; "),
)

/** The zoom's description for a chat on `model`, the entry `id`: its own numbers only. */
export const zoomFor = (id: string, model: ImageFit.Model) => {
  const zoom = model.zoom
  if (!zoom) return fitted(limitsOf(id, model))
  const box = zoom.box ? `${zoom.box.long}×${zoom.box.short}` : `a long edge of ${model.edge.toLocaleString("en-US")} px`
  return `The region to show, in pixels of the image as shown. It is enlarged by the largest whole factor, up to ${zoom.enlarge}×, that keeps it within ${box} and ${model.tokens.toLocaleString("en-US")} visual tokens, and never shrunk: a region too large to show at its own resolution is refused, and the refusal gives the largest region of its shape that fits. Choose the region loosely, with room around what you want to see so that it is surely all in frame; it need not be tight.${zoom.ruler ? " It comes with rulers in a margin along its top and left, labelled in the original's pixels." : ""}`
}

const input = (zoom: string) =>
  Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
      .annotate({ description: "The image's number, from the line before it: [Image 7: …]. Omit it to list the images." })
      .pipe(optional),
    zoom: Schema.Struct({
      x: Pixels.annotate({ description: "Left edge, in pixels of the image as shown" }),
      y: Pixels.annotate({ description: "Top edge, in pixels of the image as shown" }),
      width: Pixels.annotate({ description: "Width, in pixels of the image as shown" }),
      height: Pixels.annotate({ description: "Height, in pixels of the image as shown" }),
    })
      .annotate({ description: zoom })
      .pipe(optional),
  })

export const Input = input(ZOOM)

// The catalog shows the first line; the zoom's limits are in its signature, where `zoom` is described.
export const DESCRIPTION = [
  "See this chat's images again, zoom into them, or list them; each result says the scale it is shown at.",
  "Every image in the chat is numbered; the line before it gives its number, original size and the size it is shown at. `image.show({ id })` shows image `id` again, whole, such as after a compaction. `image.show({ id, zoom: { x, y, width, height } })` cuts that region, in pixels of the image as shown, from the full-resolution original. `image.show({})` lists the images.",
].join("\n")

/** The Code Mode group of the image tools: `image.show` here, `image.generate` in image-generate.ts. */
export const GROUP = "image"
/** The tool's registered name, its group's and its own (`Tool.Variant`). */
const ID = `${GROUP}_show`

// One variant per entry, built once, so a chat on one model is offered the same text at every step.
const VARIANTS = new Map(
  Object.entries(ImageFit.MODELS).map(([id, model]): [ImageFit.Model, Tool.Variant] => {
    const shaped = input(zoomFor(id, model))
    return [
      model,
      { key: `${ID}:${id}`, tool: (tool) => (tool.id === ID ? { ...tool, input: shaped } : tool) },
    ]
  }),
)

/** The tools as a chat on the model of `entry` is offered them (`Tool.snapshot`): `image.show` with its own text. */
export const variant = (entry: ImageFit.Model | undefined) => (entry === undefined ? undefined : VARIANTS.get(entry))

const NOT_HERE =
  "image.show works only in chats whose model has optimized images (Settings › Session › Optimize images); this chat's model has none."

// A zoom's name, which its line shows and a zoom of it is refused by; before spec image-zoom, `region W×H of image N`.
const ZOOMED = /^zoom of image (\d+), x (\d+)–(\d+) y (\d+)–(\d+)$/
const ZOOMED_BEFORE = /^region \d+×\d+ of image (\d+)$/

export const Plugin = {
  id: "openforge.tool.image",
  effect: Effect.fn("ImageTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const failure = (message: string) => new ToolFailure({ message })

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: GROUP,
          description: "See this chat's images again and zoom into them, or make new ones.",
        })
        if (!ImageBank.setting(loaded.entries)) return
        editor.add({
          name: "show",
          description: DESCRIPTION,
          input: Input,
          options: { namespace: GROUP },
          execute: (input) =>
            Effect.gen(function* () {
              const chat = yield* ImageBank.Current
              if (!chat) return yield* failure(NOT_HERE)
              if (input.id === undefined) {
                const images = yield* ImageBank.list(chat.db, chat.sessionID)
                return {
                  content:
                    images.length === 0
                      ? "This chat has no images yet."
                      : images
                          .map(
                            (image) =>
                              `Image ${image.number}: ${image.name}, ${image.width}×${image.height}, shown at ${image.shown_width}×${image.shown_height}${image.hash === "" ? " (removed: this chat was untouched for 30 days)" : ""}`,
                          )
                          .join("\n"),
                }
              }
              const found = yield* ImageBank.get(chat.db, chat.sessionID, input.id)
              if (!found) return yield* failure(`This chat has no image ${input.id}.`)
              if (!found.original) return { content: `${PictureRemoved.shown(`Image ${input.id}`)}.` }
              const zoom = input.zoom
              if (!zoom)
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Image ${input.id}, whole: ${found.image.width}×${found.image.height}, ${ImageFit.shownAs(found.image.width, found.image.height, chat.model)}.`,
                    },
                    {
                      type: "file" as const,
                      uri: `data:${found.original.mime};base64,${found.original.data.toString("base64")}`,
                      mime: found.original.mime,
                      name: found.image.name,
                    },
                  ],
                }
              const settings = chat.model.zoom
              if (settings) {
                const zoomed = ZOOMED.exec(found.image.name)
                const before = ZOOMED_BEFORE.exec(found.image.name)
                if (zoomed)
                  return yield* failure(
                    `Image ${input.id} is a zoom and is not zoomed again; zoom into image ${zoomed[1]} instead: this zoom shows its x ${zoomed[2]}–${zoomed[3]}, y ${zoomed[4]}–${zoomed[5]}.`,
                  )
                if (before)
                  return yield* failure(
                    `Image ${input.id} is a zoom and is not zoomed again; zoom into image ${before[1]} instead.`,
                  )
                const cut = yield* Effect.promise(() =>
                  ImageFit.zoom(found.original.data, zoom, chat.model, settings),
                )
                if (typeof cut === "string") return yield* failure(cut)
                const o = cut.original
                const x = `${o.left}–${o.left + o.width - 1}`
                const y = `${o.top}–${o.top + o.height - 1}`
                const size = `${cut.size.width}×${cut.size.height}`
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Region ${o.width}×${o.height} of image ${input.id} (x=${zoom.x} y=${zoom.y} ${zoom.width}×${zoom.height} as shown): x ${x} and y ${y} of the original's pixels, ${cut.factor > 1 ? `enlarged ${cut.factor}× to ${size}` : `shown at its own resolution, ${size}`}.${settings.ruler ? ` ${ImageRuler.note(cut.margin, chat.model.grid.cell)}` : ""}`,
                    },
                    {
                      type: "file" as const,
                      uri: `data:image/png;base64,${Buffer.from(cut.bytes).toString("base64")}`,
                      mime: "image/png",
                      name: `zoom of image ${input.id}, x ${x} y ${y}`,
                    },
                  ],
                }
              }
              const cut = yield* Effect.promise(() => ImageFit.crop(found.original.data, zoom, chat.model))
              if (typeof cut === "string") return yield* failure(cut)
              const size = `${cut.original.width}×${cut.original.height}`
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Region ${size} of image ${input.id} (x=${zoom.x} y=${zoom.y} ${zoom.width}×${zoom.height} as shown), ${ImageFit.shownAs(cut.original.width, cut.original.height, chat.model)}.`,
                  },
                  {
                    type: "file" as const,
                    uri: `data:image/png;base64,${Buffer.from(cut.bytes).toString("base64")}`,
                    mime: "image/png",
                    name: `region ${size} of image ${input.id}`,
                  },
                ],
              }
            }),
        })
      })
      .pipe(Effect.orDie)
  }),
}
