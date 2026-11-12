export * as ImageTool from "./image.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { optional } from "@opencode/schema/schema"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { ImageBank } from "../../image/bank.js"
import { ImageFit } from "../../image/fit.js"

// The image bank's tool (spec images): `image.show` lists a chat's images, shows one again whole, or zooms into a region
// of its full-resolution original. Registered only while Settings › Session "Optimize images" is on; a Code Mode tool in
// the `image` group, beside opencode's `image.generate` (spec image-tools). What it shows is an image arriving like any
// other: numbered with its line, counted toward the limits.

const Pixels = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// The models' limits, built once from the table, so the cached catalog never changes between requests.
const limits = Object.entries(ImageFit.MODELS)
  .map(([id, model]) => {
    const example = ImageFit.fit(16_000, 9_000, model)
    return `${id}: long edge ${model.edge.toLocaleString("en-US")} px and ${model.tokens.toLocaleString("en-US")} visual tokens, ⌈w/28⌉×⌈h/28⌉, about ${((model.tokens * 784) / 1e6).toFixed(2)} MP, e.g. ${example.width}×${example.height}`
  })
  .join("; ")

export const ZOOM = `The region to show at full detail, in pixels of the image as shown. It is shown at its own resolution up to the model's limits (${limits}); a larger region is scaled down to fit. Omit it to show the whole image again.`

export const Input = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({ description: "The image's number, from the line before it: [Image 7: …]. Omit it to list the images." })
    .pipe(optional),
  zoom: Schema.Struct({
    x: Pixels.annotate({ description: "Left edge, in pixels of the image as shown" }),
    y: Pixels.annotate({ description: "Top edge, in pixels of the image as shown" }),
    width: Pixels.annotate({ description: "Width, in pixels of the image as shown" }),
    height: Pixels.annotate({ description: "Height, in pixels of the image as shown" }),
  })
    .annotate({ description: ZOOM })
    .pipe(optional),
})

// The catalog shows the first line; the zoom's limits are in its signature, where `zoom` is described.
export const DESCRIPTION = [
  "See this chat's images again, zoom into them, or list them; each result says the scale it is shown at.",
  "Every image in the chat is numbered; the line before it gives its number, original size and the size it is shown at. `image.show({ id })` shows image `id` again, whole, such as after a compaction. `image.show({ id, zoom: { x, y, width, height } })` cuts that region, in pixels of the image as shown, from the full-resolution original. `image.show({})` lists the images.",
].join("\n")

/** The Code Mode group of the image tools: `image.show` here, `image.generate` in image-generate.ts. */
export const GROUP = "image"

const NOT_HERE =
  "image.show works only in chats whose model has optimized images (Settings › Session › Optimize images); this chat's model has none."

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
                              `Image ${image.number}: ${image.name}, ${image.width}×${image.height}, shown at ${image.shown_width}×${image.shown_height}`,
                          )
                          .join("\n"),
                }
              }
              const found = yield* ImageBank.get(chat.db, chat.sessionID, input.id)
              if (!found) return yield* failure(`This chat has no image ${input.id}.`)
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
