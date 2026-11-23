import { describe, expect, test } from "bun:test"
import { LanguageModel, ToolDefinition } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIChat, OpenAICompatibleResponses } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageFit } from "@opencode/core/image/fit"
import { PhotonNormalize } from "@opencode/core/image/photon-normalize"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PacerTools } from "@opencode/core/pacer/tools"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { ImageTool } from "@opencode/core/tool/plugin/image"
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { it, testEffect } from "./lib/effect"
import { registerToolPlugin, toolIdentity } from "./lib/tool"

// Spec image-zoom: for a model whose entry has `zoom`, image.show enlarges the region by the largest whole factor from
// 4× down that keeps the zoom image, with the ruler's margin when it has one, within the model's box and visual tokens;
// shows it at its own resolution when none does; never shrinks one; says exactly what it shows; refuses a zoom of a
// zoom; and describes itself with the chat's model's own numbers. claude-opus-5-5 has the owner's token-grid ruler and
// the 2576×1449 box; deepseek-v4.1-flash neither. Models without an entry keep today's zoom and text.

const opus = ImageFit.MODELS["claude-opus-5-5"]
const deepseek = ImageFit.MODELS["deepseek-v4.1-flash"]
const settings = opus.zoom!
const photon = await PhotonNormalize.load()

const png = (width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]) => {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set([...pixel(x, y), 255], (y * width + x) * 4)
  const image = new photon.PhotonImage(pixels, width, height)
  const bytes = image.get_bytes()
  image.free()
  return bytes
}

/** A smooth picture of this size: a small gradient, enlarged. */
const picture = (width: number, height: number) =>
  new Bun.Image(png(64, 48, (x, y) => [x * 4, y * 5, (x + y) * 2]))
    .resize(width, height)
    .png()
    .bytes()

const decode = (bytes: Uint8Array) => {
  const image = photon.PhotonImage.new_from_byteslice(bytes)
  const decoded = { width: image.get_width(), height: image.get_height(), pixels: image.get_raw_pixels() }
  image.free()
  return decoded
}

const zoomed = async (source: Uint8Array, region: ImageFit.Region) => {
  const cut = await ImageFit.zoom(source, region, opus, settings)
  if (typeof cut === "string") throw new Error(cut)
  return cut
}

describe("the factor", () => {
  // 1920×1080 is shown as it is, so a region's pixels are the original's.
  const source = picture(1920, 1080)

  test("the largest whole factor from 4× down at which the zoom image, with the ruler's margin, fits 2576×1449", async () => {
    // 4×355 + 28 = 1,448 px on the short edge: 4×.
    expect((await zoomed(await source, { x: 10, y: 10, width: 400, height: 355 })).factor).toBe(4)
    // 4×358 = 1,432 would fit alone, but with the 28-px margin the short edge is 1,460: 3×.
    expect((await zoomed(await source, { x: 10, y: 10, width: 400, height: 358 })).factor).toBe(3)
    // The box holds either way round: 1256×1460 has a short edge of 1,256 and a long one of 1,460.
    expect((await zoomed(await source, { x: 10, y: 10, width: 300, height: 358 })).factor).toBe(4)
    // 4×640 = 2,560 would fit alone, but with the 56-px margin it is 2,616 wide: 3×.
    expect((await zoomed(await source, { x: 10, y: 10, width: 640, height: 100 })).factor).toBe(3)
    // 3×700 + 28 is over 1,449; 2× is 2256×1428.
    const two = await zoomed(await source, { x: 10, y: 10, width: 1100, height: 700 })
    expect([two.factor, two.size]).toEqual([2, { width: 2200, height: 1400 }])
    const image = decode(two.bytes)
    expect([image.width, image.height]).toEqual([2256, 1428])
    expect(ImageFit.tokens(image.width, image.height, opus)).toBeLessThanOrEqual(4_784)
  })

  test("at its own resolution, with the ruler, when no factor of 2 or more fits", async () => {
    const cut = await zoomed(await source, { x: 0, y: 0, width: 1200, height: 1000 })
    expect([cut.factor, cut.size]).toEqual([1, { width: 1200, height: 1000 }])
    const image = decode(cut.bytes)
    expect([image.width, image.height]).toEqual([1256, 1028])
  })

  test("never shrunk: a region too large is refused with the largest of its shape, in pixels as shown", async () => {
    // 4000×3000 is shown at 2212×1659: the whole of it is 4000×3000 of the original, over the box at 1×.
    const large = await picture(4000, 3000)
    const refused = await ImageFit.zoom(large, { x: 0, y: 0, width: 2212, height: 1659 }, opus, settings)
    expect(typeof refused).toBe("string")
    const found = (refused as string).match(
      /^The zoom shows a region at its own resolution or enlarged, never smaller: this one, 4000×3000 pixels of the original, is too large with its ruler\. The largest region of its shape that fits is (\d+)×(\d+) pixels of the image as shown\.$/,
    )
    expect(found).not.toBeNull()
    const largest = { width: Number(found![1]), height: Number(found![2]) }
    expect(Math.abs(largest.width / largest.height - 2212 / 1659)).toBeLessThan(0.01)
    // It fits wherever it lies, at its own resolution.
    for (const at of [
      { x: 0, y: 0 },
      { x: 2212 - largest.width, y: 1659 - largest.height },
      { x: 333, y: 77 },
    ]) {
      const cut = await zoomed(large, { ...at, ...largest })
      expect(cut.factor).toBe(1)
      const image = decode(cut.bytes)
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2_576)
      expect(Math.min(image.width, image.height)).toBeLessThanOrEqual(1_449)
    }
    // A few pixels more of the same shape do not.
    expect(
      typeof (await ImageFit.zoom(
        large,
        { x: 0, y: 0, width: largest.width + 8, height: largest.height + 6 },
        opus,
        settings,
      )),
    ).toBe("string")
  })
})

describe("the ruler", () => {
  test("a dark margin of whole token cells along the top and left only, the picture unchanged inside it", async () => {
    const source = await picture(1920, 1080)
    const cut = await zoomed(source, { x: 400, y: 300, width: 120, height: 80 })
    expect(cut.margin).toEqual({ top: 28, left: 56 })
    const image = decode(cut.bytes)
    expect([image.width, image.height]).toEqual([56 + cut.size.width, 28 + cut.size.height])
    // The enlarged region, pixel for pixel, from the margin to the bottom-right corner.
    const original = photon.PhotonImage.new_from_byteslice(source)
    const crop = photon.crop(original, 400, 300, 520, 380)
    const enlarged = photon.resize(crop, cut.size.width, cut.size.height, photon.SamplingFilter.Lanczos3)
    const expected = enlarged.get_raw_pixels()
    for (let row = 0; row < cut.size.height; row++) {
      const start = ((28 + row) * image.width + 56) * 4
      expect(
        Buffer.from(image.pixels.subarray(start, start + cut.size.width * 4)).equals(
          Buffer.from(expected.subarray(row * cut.size.width * 4, (row + 1) * cut.size.width * 4)),
        ),
      ).toBe(true)
    }
    new Set([original, crop, enlarged]).forEach((item) => item.free())
  })

  test.each([
    ["4×", { x: 70, y: 49, width: 120, height: 80 }, 4],
    ["3×", { x: 70, y: 49, width: 640, height: 300 }, 3],
  ])("%s: a tick in every token cell, on the centre of the original pixel the cell's border falls in", async (_, region, factor) => {
    const cut = await zoomed(await picture(1920, 1080), region)
    expect(cut.factor).toBe(factor)
    for (const [axis, origin, size, offset] of [
      ["x", region.x, cut.size.width, 56],
      ["y", region.y, cut.size.height, 28],
    ] as const) {
      const ticks = cut.ticks.filter((tick) => tick.axis === axis)
      expect(ticks).toHaveLength(Math.ceil(size / 28))
      ticks.forEach((tick, index) => {
        const border = offset + index * 28
        // The pixel it names spans [at − k/2, at + k/2) in the zoom image, and the cell's border falls in it.
        expect(tick.at).toBe(offset + (tick.value - origin + 0.5) * factor)
        expect(border).toBeGreaterThanOrEqual(tick.at - factor / 2)
        expect(border).toBeLessThan(tick.at + factor / 2)
        expect(tick.major).toBe(index % 4 === 0)
        if (tick.labelled) expect(tick.major).toBe(true)
      })
      expect(ticks.filter((tick) => tick.labelled).length).toBeGreaterThan(0)
    }
  })

  test("a label names the original pixel drawn under its tick, and its tick is drawn in the margin", async () => {
    // Bright one-pixel columns and rows on every 7th pixel: at 4×, a 28-px cell is 7 original pixels, so from an
    // origin on a multiple of 7 every tick names a bright one.
    const source = png(700, 420, (x, y) => (x % 7 === 0 || y % 7 === 0 ? [250, 250, 250] : [30, 40, 35]))
    const cut = await zoomed(source, { x: 140, y: 70, width: 98, height: 63 })
    expect(cut.factor).toBe(4)
    const image = decode(cut.bytes)
    const red = (x: number, y: number) => image.pixels[(y * image.width + x) * 4]
    // The brightness-weighted centre of the line near `at` along the picture, between two lines 28 px apart.
    const centre = (at: number, value: (position: number) => number) => {
      const cells = Array.from({ length: 21 }, (_, index) => Math.floor(at) - 10 + index)
      const weights = cells.map((position) => Math.max(0, value(position) - 60))
      const total = weights.reduce((sum, weight) => sum + weight, 0)
      return cells.reduce((sum, position, index) => sum + (position + 0.5) * weights[index], 0) / total
    }
    const labelled = cut.ticks.filter((tick) => tick.labelled)
    expect(labelled.length).toBeGreaterThanOrEqual(3)
    for (const tick of labelled) {
      expect(tick.value % 7).toBe(0)
      if (tick.axis === "x") {
        // Measured on a row between two bright rows.
        expect(Math.abs(centre(tick.at, (x) => red(x, 28 + 14)) - tick.at)).toBeLessThan(0.25)
        expect(red(Math.floor(tick.at), 27)).toBeGreaterThan(200)
      }
      if (tick.axis === "y") {
        expect(Math.abs(centre(tick.at, (y) => red(56 + 14, y)) - tick.at)).toBeLessThan(0.25)
        expect(red(55, Math.floor(tick.at))).toBeGreaterThan(200)
      }
    }
  })
})

describe("deepseek-v4.1-flash: enlarged within its own limits, without a ruler", () => {
  const zoomedDeepSeek = async (source: Uint8Array, region: ImageFit.Region) => {
    const cut = await ImageFit.zoom(source, region, deepseek, deepseek.zoom!)
    if (typeof cut === "string") throw new Error(cut)
    return cut
  }
  // 1500×1000 is 890 of DeepSeek's tokens, shown as it is, so a region's pixels are the original's.
  const source = picture(1500, 1000)

  test("the largest whole factor from 4× down within 1,024 visual tokens of 42 px and a 4,096-px edge, no 2576×1449 box", async () => {
    // 4×325 = 1300×1300: (31+1)×31+2 = 994 tokens.
    expect((await zoomedDeepSeek(await source, { x: 10, y: 10, width: 325, height: 325 })).factor).toBe(4)
    // 4×326 = 1304×1304 is (32+1)×32+2 = 1,058: 3×.
    expect((await zoomedDeepSeek(await source, { x: 10, y: 10, width: 326, height: 326 })).factor).toBe(3)
    // 4×1100 = 4,400 is over the 4,096-px edge; 3× is 3300×30, longer than Opus's 2,576 and within DeepSeek's limits.
    const wide = await zoomedDeepSeek(await source, { x: 10, y: 10, width: 1100, height: 10 })
    expect([wide.factor, wide.size]).toEqual([3, { width: 3300, height: 30 }])
    // 3× of 600×450 is 1,454 tokens, 2× (1200×900) 662.
    const two = await zoomedDeepSeek(await source, { x: 10, y: 10, width: 600, height: 450 })
    expect([two.factor, two.size]).toEqual([2, { width: 1200, height: 900 }])
    const image = decode(two.bytes)
    expect([image.width, image.height]).toEqual([1200, 900])
    expect(ImageFit.tokens(image.width, image.height, deepseek)).toBeLessThanOrEqual(1_024)
  })

  test("at its own resolution when no factor of 2 or more fits", async () => {
    // 2× of 1000×750 is 1,766 tokens; 1× is 452.
    const cut = await zoomedDeepSeek(await source, { x: 0, y: 0, width: 1000, height: 750 })
    expect([cut.factor, cut.size]).toEqual([1, { width: 1000, height: 750 }])
    expect(decode(cut.bytes)).toMatchObject({ width: 1000, height: 750 })
  })

  test("no margin and no ruler: the image is the enlarged region, pixel for pixel", async () => {
    const bytes = await source
    const cut = await zoomedDeepSeek(bytes, { x: 400, y: 300, width: 120, height: 80 })
    expect([cut.factor, cut.margin, cut.ticks]).toEqual([4, { top: 0, left: 0 }, []])
    const original = photon.PhotonImage.new_from_byteslice(bytes)
    const crop = photon.crop(original, 400, 300, 520, 380)
    const enlarged = photon.resize(crop, 480, 320, photon.SamplingFilter.Lanczos3)
    const image = decode(cut.bytes)
    expect([image.width, image.height]).toEqual([480, 320])
    expect(Buffer.from(image.pixels).equals(Buffer.from(enlarged.get_raw_pixels()))).toBe(true)
    new Set([original, crop, enlarged]).forEach((item) => item.free())
  })

  test("never shrunk: a region too large is refused with the largest of its shape, no ruler named", async () => {
    // 4000×3000 is shown at 1512×1134: the whole of it is 4000×3000 of the original, over 1,024 tokens at 1×.
    const large = await picture(4000, 3000)
    const refused = await ImageFit.zoom(large, { x: 0, y: 0, width: 1512, height: 1134 }, deepseek, deepseek.zoom!)
    const found = String(refused).match(
      /^The zoom shows a region at its own resolution or enlarged, never smaller: this one, 4000×3000 pixels of the original, is too large\. The largest region of its shape that fits is (\d+)×(\d+) pixels of the image as shown\.$/,
    )
    expect(found).not.toBeNull()
    const largest = { width: Number(found![1]), height: Number(found![2]) }
    const cut = await zoomedDeepSeek(large, { x: 1512 - largest.width, y: 1134 - largest.height, ...largest })
    expect(cut.factor).toBe(1)
    const image = decode(cut.bytes)
    expect(ImageFit.tokens(image.width, image.height, deepseek)).toBeLessThanOrEqual(1_024)
  })
})

// A chat's bank and image.show, through the registry, with Optimize images on.
const optimized = Config.testLayer([new Document({ type: "document", info: new Info({ media: { image: { optimize: true } } }) })])
const registryLayer = Layer.merge(
  optimized,
  AppNodeBuilder.build(LayerNode.group([Tool.node, Database.node]), [
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  ]),
)

const chat = (id: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessionID = Session.ID.make(id)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    return { db, sessionID }
  })

/** image.show's answer in a chat on `model` whose bank holds `images`, each arriving as the request has it arrive. */
const show = Effect.fnUntraced(function* (
  bank: { readonly db: Database.Interface["db"]; readonly sessionID: Session.ID },
  model: ImageFit.Model,
  input: { readonly id: number; readonly zoom?: ImageFit.Region },
) {
  yield* registerToolPlugin(ImageTool.Plugin)
  const registry = yield* Tool.Service
  const tool = (yield* registry.list()).find((item) => item.id === "image_show")!
  const result = yield* tool
    .execute(input, { ...toolIdentity, sessionID: bank.sessionID, id: Tool.CallID.make("call_zoom"), progress: () => Effect.void })
    .pipe(
      Effect.provideService(ImageBank.Current, { db: bank.db, sessionID: bank.sessionID, model }),
      Effect.result,
    )
  if (result._tag === "Failure") return { error: result.failure.message }
  const content = typeof result.success.content === "string" ? [] : (result.success.content ?? [])
  // The zoom arrives in the bank as the request has a tool's images arrive.
  const arrived = yield* ImageBank.arriveContent(bank.db, bank.sessionID, model, "image_show", content)
  return {
    text: content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
    file: content.find((item) => item.type === "file"),
    arrived,
  }
})

const bankImage = (bank: { readonly db: Database.Interface["db"]; readonly sessionID: Session.ID }, model: ImageFit.Model, name: string, data: Uint8Array) =>
  ImageBank.arrive(bank.db, bank.sessionID, model, [{ data, mime: "image/png", name }])

describe("the result", () => {
  it.effect("says what it shows, exactly as measured, enlarged and at its own resolution", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_zoom_text")
      // The size of the benchmark's photo ZN-039-T/1-front-left.jpg, shown at 2353×1568.
      yield* bankImage(bank, opus, "front-left.png", yield* Effect.promise(() => picture(5026, 3351)))
      const enlarged = yield* show(bank, opus, { id: 1, zoom: { x: 1562, y: 729, width: 253, height: 198 } })
      expect(enlarged.text).toBe(
        "Region 541×425 of image 1 (x=1562 y=729 253×198 as shown): x 3336–3876 and y 1557–1981 of the original's pixels, enlarged 3× to 1623×1275. Rulers in a dark margin around the picture, labelled along its top and left: the picture begins 56 px from this image's left edge and 28 px from its top. The labels give the original image's pixel coordinates, a pixel's centre at its index (a tick in every 28-px block of this image, every 4th labelled, each tick on the centre of the pixel it names). Read positions off the labels.",
      )
      expect(enlarged.file).toMatchObject({ mime: "image/png", name: "zoom of image 1, x 3336–3876 y 1557–1981" })
      // It arrives as image 2, shown as it is: within the model's limits, so the arrival does not scale it.
      expect(JSON.stringify(enlarged.arrived)).toContain(
        "[Image 2: zoom of image 1, x 3336–3876 y 1557–1981, 1679×1303, shown at 1679×1303; see it again with image.show]",
      )
      const own = yield* show(bank, opus, { id: 1, zoom: { x: 100, y: 100, width: 600, height: 400 } })
      expect(own.text).toStartWith(
        "Region 1283×856 of image 1 (x=100 y=100 600×400 as shown): x 213–1495 and y 213–1068 of the original's pixels, shown at its own resolution, 1283×856. Rulers in a dark margin",
      )
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )

  it.effect("a zoom of a zoom is refused, with the source and what the zoom shows of it", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_zoom_of_zoom")
      yield* bankImage(bank, opus, "front-left.png", yield* Effect.promise(() => picture(5026, 3351)))
      yield* show(bank, opus, { id: 1, zoom: { x: 1562, y: 729, width: 253, height: 198 } })
      expect(yield* show(bank, opus, { id: 2, zoom: { x: 10, y: 10, width: 100, height: 100 } })).toEqual({
        error:
          "Image 2 is a zoom and is not zoomed again; zoom into image 1 instead: this zoom shows its x 3336–3876, y 1557–1981.",
      })
      // A zoom an earlier version made is one too.
      yield* bankImage(bank, opus, "region 541×425 of image 1", yield* Effect.promise(() => picture(541, 425)))
      expect(yield* show(bank, opus, { id: 3, zoom: { x: 10, y: 10, width: 100, height: 100 } })).toEqual({
        error: "Image 3 is a zoom and is not zoomed again; zoom into image 1 instead.",
      })
      // Shown again whole, it is as before.
      expect((yield* show(bank, opus, { id: 2 })).text).toBe("Image 2, whole: 1679×1303, shown at full resolution.")
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )

  it.effect("deepseek-v4.1-flash: the same text without the ruler's sentences, enlarged and at its own resolution", () =>
    Effect.gen(function* () {
      expect(ImageTool.variant(deepseek)?.key).toBe("image_show:deepseek-v4.1-flash")
      const bank = yield* chat("ses_zoom_deepseek")
      // Shown at 1512×1134.
      yield* bankImage(bank, deepseek, "photo.png", yield* Effect.promise(() => picture(4000, 3000)))
      const enlarged = yield* show(bank, deepseek, { id: 1, zoom: { x: 100, y: 200, width: 300, height: 150 } })
      expect(enlarged.text).toBe(
        "Region 795×397 of image 1 (x=100 y=200 300×150 as shown): x 264–1058 and y 529–925 of the original's pixels, enlarged 2× to 1590×794.",
      )
      expect(enlarged.file).toMatchObject({ mime: "image/png", name: "zoom of image 1, x 264–1058 y 529–925" })
      const file = enlarged.file?.type === "file" ? enlarged.file : undefined
      expect(decode(Buffer.from(file!.uri.split(",")[1], "base64"))).toMatchObject({ width: 1590, height: 794 })
      // It arrives as image 2, shown as it is: within DeepSeek's limits, so the arrival does not scale it.
      expect(JSON.stringify(enlarged.arrived)).toContain(
        "[Image 2: zoom of image 1, x 264–1058 y 529–925, 1590×794, shown at 1590×794; see it again with image.show]",
      )
      expect((yield* show(bank, deepseek, { id: 1, zoom: { x: 0, y: 0, width: 500, height: 400 } })).text).toBe(
        "Region 1323×1059 of image 1 (x=0 y=0 500×400 as shown): x 0–1322 and y 0–1058 of the original's pixels, shown at its own resolution, 1323×1059.",
      )
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )

  it.effect("deepseek-v4.1-flash: a zoom of a zoom is refused as for Opus", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_zoom_of_zoom_deepseek")
      yield* bankImage(bank, deepseek, "photo.png", yield* Effect.promise(() => picture(4000, 3000)))
      yield* show(bank, deepseek, { id: 1, zoom: { x: 100, y: 200, width: 300, height: 150 } })
      expect(yield* show(bank, deepseek, { id: 2, zoom: { x: 0, y: 0, width: 100, height: 100 } })).toEqual({
        error:
          "Image 2 is a zoom and is not zoomed again; zoom into image 1 instead: this zoom shows its x 264–1058, y 529–925.",
      })
      // One today's zoom made, named `region W×H of image N`, is one too.
      yield* bankImage(bank, deepseek, "region 795×397 of image 1", yield* Effect.promise(() => picture(795, 397)))
      expect(yield* show(bank, deepseek, { id: 3, zoom: { x: 10, y: 10, width: 100, height: 100 } })).toEqual({
        error: "Image 3 is a zoom and is not zoomed again; zoom into image 1 instead.",
      })
      expect((yield* show(bank, deepseek, { id: 2 })).text).toBe("Image 2, whole: 1590×794, shown at full resolution.")
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )
})

const OPUS_ZOOM =
  "The region to show, in pixels of the image as shown. It is enlarged by the largest whole factor, up to 4×, that keeps it within 2576×1449 and 4,784 visual tokens, and never shrunk: a region too large to show at its own resolution is refused, and the refusal gives the largest region of its shape that fits. Choose the region loosely, with room around what you want to see so that it is surely all in frame; it need not be tight. It comes with rulers in a margin along its top and left, labelled in the original's pixels."
const DEEPSEEK_ZOOM =
  "The region to show, in pixels of the image as shown. It is enlarged by the largest whole factor, up to 4×, that keeps it within a long edge of 4,096 px and 1,024 visual tokens, and never shrunk: a region too large to show at its own resolution is refused, and the refusal gives the largest region of its shape that fits. Choose the region loosely, with room around what you want to see so that it is surely all in frame; it need not be tight."
// Today's, for a chat whose model has no entry.
const TODAY_ZOOM =
  "The region to show at full detail, in pixels of the image as shown. It is shown at its own resolution up to the model's limits (claude-opus-5-5: long edge 2,576 px and 4,784 visual tokens, ⌈w/28⌉×⌈h/28⌉, about 3.73 MP, e.g. 2576×1449; deepseek-v4.1-flash: long edge 4,096 px and 1,024 visual tokens, (⌈w/42⌉+1)×⌈h/42⌉+2, about 1.70 MP, e.g. 1722×969); a larger region is scaled down to fit. Omit it to show the whole image again."

/** image.show's line in Code Mode's catalog, and the catalog, as a chat with this variant gets them. */
const listing = (variant: Tool.Variant | undefined) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const tools = yield* registry.snapshot(undefined, undefined, undefined, variant)
    return { tools, line: CodeModeCatalog.lookup(tools.codeModeCatalog!)("image.show")!.line }
  })

describe("the description per model", () => {
  it.effect("the catalog gives only the chat's model's numbers, the same bytes every step, others on a switch", () =>
    Effect.gen(function* () {
      yield* registerToolPlugin(ImageTool.Plugin)
      const first = yield* listing(ImageTool.variant(opus))
      const second = yield* listing(ImageTool.variant(opus))
      expect(first.line).toContain(OPUS_ZOOM)
      expect(first.line).not.toContain("deepseek")
      expect(first.line).not.toContain("scaled down")
      expect(second.line).toBe(first.line)
      expect(second.tools.codeModeCatalog).toBe(first.tools.codeModeCatalog)
      // The tool's first line, which the catalog shows, stays.
      expect(first.line).toEndWith(
        "// See this chat's images again, zoom into them, or list them; each result says the scale it is shown at.",
      )
      const switched = yield* listing(ImageTool.variant(deepseek))
      expect(switched.line).toContain(DEEPSEEK_ZOOM)
      expect(switched.line).not.toContain("claude-opus-5-5")
      expect(switched.line).not.toContain("2576×1449")
      expect(switched.line).not.toContain("rulers")
      // And back: the first chat's text again, the same object.
      expect((yield* listing(ImageTool.variant(opus))).tools.codeModeCatalog).toBe(first.tools.codeModeCatalog)
      // Without an entry, today's text.
      expect((yield* listing(undefined)).line).toContain(TODAY_ZOOM)
      expect(ImageTool.ZOOM).toBe(TODAY_ZOOM)
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )

  it.effect("search(...) in Code Mode gives the chat's model's text too", () =>
    Effect.gen(function* () {
      yield* registerToolPlugin(ImageTool.Plugin)
      const registry = yield* Tool.Service
      const found = (variant: Tool.Variant | undefined) =>
        registry.snapshot(undefined, undefined, undefined, variant).pipe(
          Effect.flatMap((tools) =>
            tools.execute({
              ...toolIdentity,
              sessionID: Session.ID.make("ses_zoom_search"),
              call: {
                type: "tool-call",
                id: "call-search",
                name: "execute",
                input: {
                  code: 'return search("image show zoom").items.find((item) => item.path.endsWith("image.show")).signature',
                },
              },
            }),
          ),
          Effect.map((result) => JSON.stringify(result.content)),
        )
      const opusSearch = yield* found(ImageTool.variant(opus))
      expect(opusSearch).toContain(OPUS_ZOOM)
      expect(opusSearch).not.toContain("deepseek")
      expect(yield* found(ImageTool.variant(deepseek))).toContain(DEEPSEEK_ZOOM)
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )

  it.effect("as a direct tool, without Code Mode, its definition is the model's, the same object every step", () =>
    Effect.gen(function* () {
      yield* registerToolPlugin(ImageTool.Plugin)
      const registry = yield* Tool.Service
      const noCodeMode = [{ action: "execute", resource: "*", effect: "deny" as const }]
      const definition = (variant: Tool.Variant | undefined) =>
        registry
          .snapshot(noCodeMode, undefined, undefined, variant)
          .pipe(Effect.map((tools) => tools.definitions.find((item) => item.name === "image_show")!))
      const zoomOf = (item: ToolDefinition) =>
        (item.inputSchema as { properties: { zoom: { description: string } } }).properties.zoom.description
      const first = yield* definition(ImageTool.variant(opus))
      expect(zoomOf(first)).toBe(OPUS_ZOOM)
      expect(yield* definition(ImageTool.variant(opus))).toBe(first)
      expect(zoomOf(yield* definition(ImageTool.variant(deepseek)))).toBe(DEEPSEEK_ZOOM)
      expect(zoomOf(yield* definition(undefined))).toBe(TODAY_ZOOM)
    }).pipe(Effect.scoped, Effect.provide(registryLayer)),
  )
})

// A chat's selection, with the registry's snapshot recorded: which variant the chat's model gets.
const sessionID = Session.ID.make("ses_zoom_selection")
const facts = {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost: [],
  limit: { context: 1_000_000, output: 32_000 },
} as const
const models = {
  opus: SessionRunnerModel.resolved(
    AnthropicMessages.route.with({ provider: "cliproxypacer" }).model({ id: "claude-opus-5-5" }),
    facts,
  ),
  deepseek: SessionRunnerModel.resolved(
    OpenAICompatibleResponses.route
      .with({ provider: "cliproxypacer", endpoint: { baseURL: "http://127.0.0.1:8317/v1" } })
      .model({ id: "deepseek/deepseek-v4.1-flash" }),
    facts,
  ),
  other: SessionRunnerModel.resolved(LanguageModel.make({ id: "other", provider: "test", route: OpenAIChat.route }), facts),
}
let current = models.opus
const variants: Array<Tool.Variant | undefined> = []
const selecting = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Config.node.replace(optimized),
      SessionRunnerModel.node.replace(
        Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.sync(() => current) }),
      ),
      InstructionBuiltIns.node.replace(
        Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, {
          project: false,
          global: false,
          claude: false,
          load: () => Effect.succeed(Instructions.empty),
        }),
      ),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: (_permissions, _location, _pins, variant) =>
            Effect.sync(() => {
              variants.push(variant)
              return { definitions: [], execute: () => Effect.die(new Error("unused")) }
            }),
          transform: () => Effect.die(new Error("unused")),
        }),
      ),
      PacerTools.node.replace(
        Layer.succeed(
          PacerTools.Service,
          PacerTools.Service.of({
            list: () => Effect.succeed(undefined),
            seen: () => {},
            cold: () => {},
            call: () => Effect.die(new Error("unused")),
            upload: () => Effect.void,
            known: () => Effect.succeed(new Map()),
            knownChanges: () => Stream.empty,
            holds: () => undefined,
            held: () => undefined,
          }),
        ),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

describe("a chat's tools", () => {
  selecting.effect("come with its model's own texts, and another model's once it switches", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const projects = yield* Project.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
          slug: "zoom-selection",
          directory: "/project",
          title: "Zoom selection",
          version: "test",
          agent: Agent.ID.make("build"),
        })
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const context = yield* SessionContext.Service
      variants.length = 0
      current = models.opus
      yield* context.select(sessionID)
      yield* context.select(sessionID)
      current = models.deepseek
      yield* context.select(sessionID)
      current = models.other
      yield* context.select(sessionID)
      expect(variants).toEqual([
        ImageTool.variant(opus),
        ImageTool.variant(opus),
        ImageTool.variant(deepseek),
        undefined,
      ])
      expect(variants[0]).toBe(variants[1])
      expect(variants[0]).toBeDefined()
    }),
  )
})
