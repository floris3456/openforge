import { describe, expect, test } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { Config } from "@opencode/core/config"
import { ImageBank } from "@opencode/core/image/bank"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Tool } from "@opencode/core/tool"
import { ImageTool } from "@opencode/core/tool/plugin/image"
import { ImageGenerateTool } from "@opencode/core/tool/plugin/image-generate"
import { Document, Event, Info } from "@opencode/schema/config"
import { ImageLine } from "@opencode/util/image-line"
import { Effect, Schedule } from "effect"
import { testEffect } from "./lib/effect"
import { codeModeListings } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

// Spec image-tools: one image group in Code Mode, image.show and image.generate, each with its own condition; the line
// before an image offers a zoom only where zooming shows more.

const it = testEffect(PluginTestLayer)

describe("the line before an image", () => {
  test("a scaled-down image offers a zoom with image.show", () => {
    expect(ImageBank.line(7, "photo.jpg", { width: 4000, height: 3000, shown: { width: 2212, height: 1659 } })).toBe(
      "[Image 7: photo.jpg, 4000×3000, shown at 2212×1659; see it again or zoom with image.show]",
    )
  })

  test("an image shown at its own size offers no zoom", () => {
    expect(ImageBank.line(2, "sun.png", { width: 1200, height: 750, shown: { width: 1200, height: 750 } })).toBe(
      "[Image 2: sun.png, 1200×750, shown at 1200×750; see it again with image.show]",
    )
  })

  test("one side scaled is scaled", () => {
    expect(ImageBank.line(3, "tall.png", { width: 800, height: 9000, shown: { width: 800, height: 8999 } })).toContain(
      "see it again or zoom with image.show]",
    )
  })

  test("both new forms are recognized, and the lines chats already hold", () => {
    for (const line of [
      "[Image 7: photo.jpg, 4000×3000, shown at 2212×1659; see it again or zoom with image.show]",
      "[Image 2: sun.png, 1200×750, shown at 1200×750; see it again with image.show]",
      "[Image 1: shot.png, 96×48, shown at 96×48; see it again or zoom with image]",
    ])
      expect(ImageLine.is(line)).toBe(true)
    expect(ImageLine.is("[Image 1: shot.png, 96×48; zoom with image.show]")).toBe(false)
    expect(ImageLine.is("see it again with image.show]")).toBe(false)
  })
})

const optimize = (on: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries([
      new Document({ type: "document", info: new Info({ media: { image: { optimize: on } } }) }),
    ])
    yield* (yield* Bus.Service).publish(Event.Updated, {})
  })

const painter = Effect.gen(function* () {
  const catalog = yield* Provider.Service
  yield* catalog.transform((editor) =>
    editor.models.update(Provider.ID.make("test"), Model.ID.make("painter"), (model) => {
      model.type = "image"
    }),
  )
})

const setup = Effect.gen(function* () {
  const host = yield* PluginHost.make(yield* Plugin.Service)
  yield* ImageTool.Plugin.effect(host)
  yield* ImageGenerateTool.Plugin.effect(host)
})

/** The image group's paths in Code Mode's catalog, once they are `expected` (config and models arrive by events). */
const paths = (expected: readonly string[]) =>
  Tool.Service.use((registry) => registry.snapshot()).pipe(
    Effect.map((tools) =>
      codeModeListings(tools.codeModeCatalog!)
        .map((tool) => tool.path)
        .filter((path) => path.startsWith("image")),
    ),
    Effect.repeat({
      until: (found) => JSON.stringify(found) === JSON.stringify(expected),
      schedule: Schedule.spaced("5 millis"),
    }),
    Effect.timeout("10 seconds"),
  )

describe("the image group", () => {
  it.live("image.show while Optimize images is on, image.generate while an image model is available", () =>
    Effect.gen(function* () {
      yield* setup
      expect(yield* paths([])).toEqual([])
      yield* optimize(true)
      expect(yield* paths(["image.show"])).toEqual(["image.show"])
      yield* painter
      expect(yield* paths(["image.generate", "image.show"])).toEqual(["image.generate", "image.show"])
      yield* optimize(false)
      expect(yield* paths(["image.generate"])).toEqual(["image.generate"])
    }),
  )

  it.live("the group says what it is for, and image.show names itself", () =>
    Effect.gen(function* () {
      yield* setup
      yield* optimize(true)
      yield* painter
      yield* paths(["image.generate", "image.show"])
      const tools = yield* Tool.Service.use((registry) => registry.snapshot())
      const summary = CodeModeCatalog.summarize(tools.codeModeCatalog!, { budget: Infinity })
      const group = summary.namespaces.find((namespace) => namespace.name === "image")
      expect(group?.description).toBe("See this chat's images again and zoom into them, or make new ones.")
      expect(ImageTool.DESCRIPTION).toContain("`image.show({ id })` shows image `id` again")
      expect(ImageTool.DESCRIPTION).not.toMatch(/`image\(/)
    }),
  )
})
