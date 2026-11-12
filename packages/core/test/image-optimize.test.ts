import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, Media, Message, ToolResultPart, type LLMRequest } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageBudget } from "@opencode/core/image/budget"
import { ImageFit } from "@opencode/core/image/fit"
import { PhotonNormalize } from "@opencode/core/image/photon-normalize"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { ImageTable } from "@opencode/core/image/sql"
import { BlobTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Money } from "@opencode/schema/money"
import { Document, type Entry, Info } from "@opencode/schema/config"
import type { Tool } from "@opencode/schema/tool"
import { ImageTool } from "@opencode/core/tool/plugin/image"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { withEnv } from "./fixture/env"
import { testEffect } from "./lib/effect"

// The rules of spec images, one test each: the size rule, the same bytes, the original kept, the line, the
// zoom's pixels, requests that only add, the exact token count, the warning once, the compaction at the limit, and
// other chats unchanged.

/** A 24-bit BMP drawn by `pixel`, which Bun.Image decodes; tests turn it into PNG or JPEG. */
function bmp(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]) {
  const header = 54
  const row = width * 3 + ((4 - ((width * 3) % 4)) % 4)
  const bytes = new Uint8Array(header + row * height)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, header, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      bytes.set([b, g, r], header + y * row + x * 3)
    }
  return bytes
}

const gradient = (width: number, height: number) =>
  new Bun.Image(bmp(width, height, (x, y) => [(x * 255) / width, (y * 255) / height, ((x + y) * 127) / (width + height)]))
    .png()
    .bytes()

/** Detail a WebP at quality 95 can't fit within the cap, so a lower quality is chosen. */
const noisy = () => {
  const state = { seed: 1 }
  const random = () => (state.seed = (state.seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  return new Bun.Image(
    bmp(1200, 900, (x, y) => {
      const noise = random() * 20
      return [(x / 5 + noise) & 255, (y / 4 + noise) & 255, ((x + y) / 7 + noise) & 255]
    }),
  )
    .png()
    .bytes()
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4
const opus = ImageFit.MODELS["claude-opus-5-5"]

describe("the size rule, against Anthropic's table", () => {
  test("3840×2160 is shown at 2576×1449, 4,784 visual tokens", () => {
    expect(ImageFit.fit(3840, 2160, opus)).toEqual({ width: 2576, height: 1449 })
    expect(ImageFit.tokens(2576, 1449)).toBe(4_784)
  })

  test("1920×1080 stays as it is, 2,691 visual tokens", () => {
    expect(ImageFit.fit(1920, 1080, opus)).toEqual({ width: 1920, height: 1080 })
    expect(ImageFit.tokens(1920, 1080)).toBe(2_691)
  })

  test("4000×3000 is shown at 2212×1659, within 4,784 tokens", () => {
    expect(ImageFit.fit(4000, 3000, opus)).toEqual({ width: 2212, height: 1659 })
    expect(ImageFit.tokens(2212, 1659)).toBeLessThanOrEqual(4_784)
  })

  test("an image is never enlarged", () => {
    expect(ImageFit.fit(300, 200, opus)).toEqual({ width: 300, height: 200 })
  })

  test("the scale a size is shown at", () => {
    expect(ImageFit.shownAs(1200, 900, opus)).toBe("shown at full resolution")
    expect(ImageFit.shownAs(4000, 3000, opus)).toBe("scaled to 2212×1659 (0.55×)")
  })
})

describe("conversion on arrival", () => {
  test("the same image always gives the same bytes, sized to the rule, as WebP", async () => {
    const source = await gradient(4000, 3000)
    const first = await ImageFit.convert(source, "image/png", opus)
    const second = await ImageFit.convert(new Uint8Array(source), "image/png", opus)
    expect(first).toBeDefined()
    expect(first!.mime).toBe("image/webp")
    expect({ width: first!.width, height: first!.height, shown: first!.shown }).toEqual({
      width: 4000,
      height: 3000,
      shown: { width: 2212, height: 1659 },
    })
    expect(await new Bun.Image(first!.data).metadata()).toMatchObject({ width: 2212, height: 1659, format: "webp" })
    expect(Buffer.from(second!.data).equals(Buffer.from(first!.data))).toBe(true)
  })

  test("the highest quality within 120 base64 bytes per visual token", async () => {
    const source = await noisy()
    const converted = await ImageFit.convert(source, "image/png", opus)
    const cap = opus.bytesPerToken * ImageFit.tokens(1200, 900)
    expect(base64Length(converted!.data.length)).toBeLessThanOrEqual(cap)
    const qualities = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30]
    const sizes = await Promise.all(
      qualities.map((quality) =>
        new Bun.Image(source).resize(1200, 900, { filter: "lanczos3" }).webp({ quality }).bytes(),
      ),
    )
    const chosen = sizes.findIndex((bytes) => Buffer.from(bytes).equals(Buffer.from(converted!.data)))
    // Below 95, and the quality one step higher would not have fit.
    expect(chosen).toBeGreaterThan(0)
    expect(base64Length(sizes[chosen - 1].length)).toBeGreaterThan(cap)
  })

  test("an image that already fits and is smaller than its WebP is kept as it came", async () => {
    const source = await new Bun.Image(
      bmp(640, 400, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [255, 255, 255] : [20, 40, 200])),
    )
      .png({ palette: true, colors: 2, compressionLevel: 9 })
      .bytes()
    const converted = await ImageFit.convert(source, "image/png", opus)
    expect(converted!.mime).toBe("image/png")
    expect(Buffer.from(converted!.data).equals(Buffer.from(source))).toBe(true)
  })

  test("the line before an image", () => {
    expect(ImageBank.line(7, "photo.jpg", { width: 4000, height: 3000, shown: { width: 2212, height: 1659 } })).toBe(
      "[Image 7: photo.jpg, 4000×3000, shown at 2212×1659; see it again or zoom with image.show]",
    )
  })
})

describe("zoom", () => {
  test("a region's pixels are the original's, cut where the shown pixels map to", async () => {
    const source = await gradient(4000, 3000)
    const cut = await ImageFit.crop(source, { x: 100, y: 200, width: 300, height: 150 }, opus)
    if (typeof cut === "string") throw new Error(cut)
    // Shown at 2212×1659: one shown pixel is 4000/2212 original pixels across and 3000/1659 down.
    expect(cut.original).toEqual({
      left: Math.floor((100 * 4000) / 2212),
      top: Math.floor((200 * 3000) / 1659),
      width: Math.ceil((400 * 4000) / 2212) - Math.floor((100 * 4000) / 2212),
      height: Math.ceil((350 * 3000) / 1659) - Math.floor((200 * 3000) / 1659),
    })
    const photon = await PhotonNormalize.load()
    const original = photon.PhotonImage.new_from_byteslice(source)
    const expected = photon.crop(
      original,
      cut.original.left,
      cut.original.top,
      cut.original.left + cut.original.width,
      cut.original.top + cut.original.height,
    )
    const zoomed = photon.PhotonImage.new_from_byteslice(cut.bytes)
    expect([zoomed.get_width(), zoomed.get_height()]).toEqual([cut.original.width, cut.original.height])
    expect(Buffer.from(zoomed.get_raw_pixels()).equals(Buffer.from(expected.get_raw_pixels()))).toBe(true)
    original.free()
    expected.free()
    zoomed.free()
  })

  test("a region outside the image as shown is refused with its size", async () => {
    const source = await gradient(4000, 3000)
    expect(await ImageFit.crop(source, { x: 2000, y: 0, width: 300, height: 10 }, opus)).toBe(
      "The zoom must lie within the image as shown, 2212×1659 pixels.",
    )
  })
})

const image = (bytes: number): Message["content"][number] => ({
  type: "media",
  media: Media.base64("A".repeat(bytes), "image/webp"),
  filename: "shot.webp",
})

describe("requests", () => {
  const limits = { count: 3, bytes: 1_000 }

  test("only add: every request repeats the one before, an image once sent is never changed", () => {
    const history = [100, 200, 300, 150, 50].map((bytes) => Message.user([image(bytes)]))
    const requests = history.map((_, index) => ImageBudget.bound(history.slice(0, index + 1), limits))
    requests.slice(1).forEach((request, index) => {
      expect(request.slice(0, index + 1)).toEqual([...requests[index]])
    })
    const last = requests.at(-1)!
    expect(last.slice(0, 3)).toEqual(history.slice(0, 3))
    // From the first image that does not fit on, each is a note where it arrived.
    expect(JSON.stringify(last.slice(3)).match(/Image not shown/g)).toHaveLength(2)
    expect(JSON.stringify(last.slice(3))).not.toContain("AAAA")
  })

  test("tool results' images count too", () => {
    const result = (bytes: number) =>
      Message.tool(
        ToolResultPart.make({
          id: `call_${bytes}`,
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: `data:image/webp;base64,${"A".repeat(bytes)}`, mime: "image/webp" }],
          },
        }),
      )
    const sent = ImageBudget.bound([result(600), result(500)], limits)
    expect(JSON.stringify(sent[1])).toContain("Image not shown")
    expect(sent[0]).toEqual(result(600))
  })

  test("visual tokens count exactly, from the image's header", async () => {
    const webp = Buffer.from(await new Bun.Image(await gradient(2212, 1659)).webp({ quality: 90 }).bytes())
    const png = Buffer.from(await gradient(1920, 1080))
    const jpeg = Buffer.from(await new Bun.Image(png).jpeg({ quality: 80 }).bytes())
    expect(ImageFit.visualTokens(webp.toString("base64"), opus)).toBe(ImageFit.tokens(2212, 1659))
    expect(ImageFit.visualTokens(png.toString("base64"), opus)).toBe(2_691)
    expect(ImageFit.visualTokens(jpeg.toString("base64"), opus)).toBe(2_691)
    // Larger than the model reads: counted at the size it reads it at.
    expect(ImageFit.visualTokens(Buffer.from(await gradient(4000, 3000)).toString("base64"), opus)).toBe(
      ImageFit.tokens(2212, 1659),
    )
  })
})

describe("which chats", () => {
  test("claude-opus-5-5 on Anthropic's Messages API, from any provider; nothing else", () => {
    const pacer = AnthropicMessages.route.with({ provider: "cliproxypacer" }).model({ id: "claude-opus-5-5" })
    expect(ImageFit.forModel({ model: pacer })).toBe(opus)
    expect(ImageFit.forModel({ model: AnthropicMessages.route.model({ id: "claude-sonnet-5" }) })).toBeUndefined()
    expect(ImageFit.forModel({ model: OpenAIChat.route.model({ id: "claude-opus-5-5" }) })).toBeUndefined()
  })

  test("the setting is off unless the last config that sets it turns it on", () => {
    const doc = (optimize?: boolean): Entry =>
      Document.make({ type: "document", info: Info.make(optimize === undefined ? {} : { media: { image: { optimize } } }) })
    expect(ImageBank.setting([])).toBe(false)
    expect(ImageBank.setting([doc(true)])).toBe(true)
    expect(ImageBank.setting([doc(true), doc(false)])).toBe(false)
    expect(ImageBank.setting([doc(true), doc()])).toBe(true)
  })

  test("the tool states each model's zoom limits where the catalog shows them, the same text every time", () => {
    expect(ImageTool.ZOOM).toContain(
      "claude-opus-5-5: long edge 2,576 px and 4,784 visual tokens, ⌈w/28⌉×⌈h/28⌉, about 3.75 MP, e.g. 2576×1449",
    )
    expect(ImageTool.ZOOM).toContain("a larger region is scaled down to fit")
    // The catalog lists the first line, up to 120 characters, and the signature with `zoom`'s description.
    expect(ImageTool.DESCRIPTION.split("\n")[0].length).toBeLessThanOrEqual(120)
    expect(JSON.stringify(Schema.toJsonSchemaDocument(ImageTool.Input))).toContain("2,576 px")
  })
})

// The session store, projector, compaction and requests, with a model that answers every request with a summary.
let requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- the summary" }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(
  AnthropicMessages.route.with({ provider: "anthropic" }).model({ id: "claude-opus-5-5" }),
  {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(1),
        cache: { read: Money.USDPerMillionTokens.make(1), write: Money.USDPerMillionTokens.make(1) },
      },
    ],
    limit: { context: 1_000_000, output: 32_000 },
  },
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    const session = yield* store.get(id)
    if (!session) return yield* Effect.die(`session missing: ${id}`)
    return session
  })

const storeMessages = (sessionID: Session.ID, messages: readonly SessionMessage.Info[]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(SessionMessageTable)
      .values(
        messages.map((message, index) => {
          const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
          return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: index + 1, time_created: 0, data }
        }),
      )
      .run()
      .pipe(Effect.orDie)
    yield* Bus.reserveSequence(db, sessionID, messages.length)
  })

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
  tools: { definitions: [], execute: () => Effect.die("unused") },
  images: opus,
})

const user = (text: string) =>
  SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, time: { created: DateTime.makeUnsafe(0) } })

/** An assistant step whose tool returned this content. */
const toolResult = (content: ReadonlyArray<Tool.Content>) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "claude-opus-5-5", providerID: "anthropic" },
    content: [
      {
        type: "tool",
        id: `call_${SessionMessage.ID.create()}`,
        name: "read",
        state: { status: "completed", input: {}, content },
        time: { created: 0 },
      },
    ],
    time: { created: 0, completed: 0 },
  })

/** An assistant step whose tool returned these images, each after its line. */
const toolImages = (images: ReadonlyArray<{ line: string; data: string }>) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "claude-opus-5-5", providerID: "anthropic" },
    content: [
      {
        type: "tool",
        id: `call_${SessionMessage.ID.create()}`,
        name: "read",
        state: {
          status: "completed",
          input: {},
          content: images.flatMap((image) => [
            { type: "text", text: image.line },
            { type: "file", uri: `data:image/webp;base64,${image.data}`, mime: "image/webp", name: "shot.webp" },
          ]),
        },
        time: { created: 0 },
      },
    ],
    time: { created: 0, completed: 0 },
  })

const textOf = (item: Tool.Content | undefined) => (item?.type === "text" ? item.text : item?.mime)

describe("arrival in a chat", () => {
  it.effect("keeps each original, numbers images in order, puts its line before each, and repeats a known one", () =>
    Effect.gen(function* () {
      const session = yield* insertSession(Session.ID.make("ses_image_arrival"))
      const db = (yield* Database.Service).db
      const photo = Buffer.from(yield* Effect.promise(() => gradient(4000, 3000)))
      const small = Buffer.from(yield* Effect.promise(() => gradient(300, 200)))
      const content = yield* ImageBank.arriveContent(db, session.id, opus, "read", [
        { type: "text", text: "Read two images" },
        { type: "file", uri: `data:image/png;base64,${photo.toString("base64")}`, mime: "image/png", name: "photo.png" },
        { type: "file", uri: `data:image/png;base64,${small.toString("base64")}`, mime: "image/png" },
      ])
      expect(content.map(textOf)).toEqual([
        "Read two images",
        "[Image 1: photo.png, 4000×3000, shown at 2212×1659; see it again or zoom with image.show]",
        "image/webp",
        "[Image 2: image from read, 300×200, shown at 300×200; see it again with image.show]",
        expect.stringMatching(/^image\/(png|webp)$/),
      ])
      const blob = yield* db
        .select()
        .from(BlobTable)
        .where(eq(BlobTable.hash, new Bun.CryptoHasher("sha256").update(photo).digest("hex")))
        .get()
        .pipe(Effect.orDie)
      expect(blob).toMatchObject({ mime: "image/png", width: 4000, height: 3000, bytes: photo.length })
      expect(Buffer.from(blob!.data).equals(photo)).toBe(true)
      const found = yield* ImageBank.get(db, session.id, 1)
      expect(found?.original.data.equals(photo)).toBe(true)
      expect(found?.image).toMatchObject({ name: "photo.png", width: 4000, height: 3000, shown_width: 2212 })
      // Shown again: the same number, line and bytes.
      const again = yield* ImageBank.arriveContent(db, session.id, opus, "image", [
        { type: "file", uri: `data:image/png;base64,${photo.toString("base64")}`, mime: "image/png", name: "photo.png" },
      ])
      expect(again).toEqual(content.slice(1, 3))
      expect(yield* ImageBank.list(db, session.id)).toHaveLength(2)
    }),
  )

  it.effect("images arriving at once never share a number", () =>
    Effect.gen(function* () {
      const session = yield* insertSession(Session.ID.make("ses_image_parallel"))
      const db = (yield* Database.Service).db
      const sources = yield* Effect.promise(() => Promise.all([1, 2, 3, 4].map((n) => gradient(100 * n, 80))))
      const results = yield* Effect.forEach(
        sources,
        (source) =>
          ImageBank.arriveContent(db, session.id, opus, "read", [
            { type: "file", uri: `data:image/png;base64,${Buffer.from(source).toString("base64")}`, mime: "image/png" },
          ]),
        { concurrency: "unbounded" },
      )
      const numbers = results.map((content) => Number(/^\[Image (\d+):/.exec(textOf(content[0]) ?? "")?.[1]))
      expect(numbers.toSorted()).toEqual([1, 2, 3, 4])
      const rows = yield* db.select().from(ImageTable).where(eq(ImageTable.session_id, session.id)).all().pipe(Effect.orDie)
      expect(rows.map((row) => row.number).toSorted()).toEqual([1, 2, 3, 4])
    }),
  )
})

describe("forks", () => {
  it.effect("a fork carries the images its history names, under the same numbers, with their originals", () =>
    Effect.gen(function* () {
      const session = yield* insertSession(Session.ID.make("ses_image_fork_parent"))
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const sources = yield* Effect.promise(() => Promise.all([gradient(300, 200), gradient(400, 300)]))
      const [first, second] = yield* Effect.forEach(sources, (source) =>
        ImageBank.arriveContent(db, session.id, opus, "read", [
          { type: "file", uri: `data:image/png;base64,${Buffer.from(source).toString("base64")}`, mime: "image/png" },
        ]),
      )
      const named = toolResult(first)
      const later = toolResult(second)
      yield* storeMessages(session.id, [user("look"), named, later])
      const childID = Session.ID.make("ses_image_fork_child")
      yield* bus.publish(SessionEvent.Forked, {
        sessionID: childID,
        parentID: session.id,
        boundary: { type: "through", messageID: named.id },
      })
      // Image 1 is in the fork's history; image 2 came after the boundary.
      expect((yield* ImageBank.list(db, childID)).map((image) => image.number)).toEqual([1])
      const found = yield* ImageBank.get(db, childID, 1)
      expect(found?.original.data.equals(Buffer.from(sources[0]))).toBe(true)
      // The fork keeps it with the parent gone.
      yield* bus.publish(SessionEvent.Deleted, { sessionID: session.id })
      expect((yield* ImageBank.get(db, childID, 1))?.original.data.equals(Buffer.from(sources[0]))).toBe(true)
    }),
  )
})

describe("before a step", () => {
  const shot = (n: number) => ({
    line: `[Image ${n}: shot.webp, 10×10, shown at 10×10; see it again or zoom with image]`,
    data: "A".repeat(400),
  })

  it.effect("the image that leaves less room than one more full-size image gets one warning", () =>
    withEnv({ OPENFORGE_TEST_IMAGE_LIMITS: "3,1000000" }, () =>
      Effect.gen(function* () {
        const session = yield* insertSession(Session.ID.make("ses_image_warning"))
        const first = [user("look"), toolImages([shot(1)])]
        const second = toolImages([shot(2)])
        yield* storeMessages(session.id, [...first, second])
        const compaction = yield* SessionCompaction.Service
        const bus = yield* Bus.Service
        const store = yield* SessionStore.Service
        const estimate = { measured: 0, estimated: 0 }
        // One image: room for two more, no warning.
        expect(yield* ImageBudget.before({ loaded: loaded(session, first), estimate, compaction, bus })).toBe(false)
        expect(
          yield* ImageBudget.before({ loaded: loaded(session, [...first, second]), estimate, compaction, bus }),
        ).toBe(true)
        const after = yield* store.context(session.id)
        expect(after.filter((message) => message.type === "synthetic")).toMatchObject([
          { text: ImageBudget.WARNING, description: ImageBudget.WARNING },
        ])
        expect(ImageBudget.WARNING).toBe("The next image will compact this chat first.")
        // Once: the next step's check sees the warning already there.
        expect(yield* ImageBudget.before({ loaded: loaded(session, after), estimate, compaction, bus })).toBe(false)
        expect((yield* store.context(session.id)).filter((message) => message.type === "synthetic")).toHaveLength(1)
      }),
    ),
  )

  it.effect("an image that would not fit compacts first; the summary keeps the numbers, the image goes out after it", () =>
    withEnv({ OPENFORGE_TEST_IMAGE_LIMITS: "3,1000000" }, () =>
      Effect.gen(function* () {
        requests = []
        const session = yield* insertSession(Session.ID.make("ses_image_limit"))
        const messages = [
          user("look"),
          toolImages([shot(1), shot(2), shot(3)]),
          user("and this"),
          toolImages([shot(4)]),
        ]
        yield* storeMessages(session.id, messages)
        const compaction = yield* SessionCompaction.Service
        const bus = yield* Bus.Service
        const store = yield* SessionStore.Service
        expect(
          yield* ImageBudget.before({
            loaded: loaded(session, messages),
            estimate: { measured: 0, estimated: 0 },
            compaction,
            bus,
          }),
        ).toBe(true)
        // The summary is written from what was already sent: three images, the fourth a note.
        expect(requests).toHaveLength(1)
        const sent = JSON.stringify(requests[0].messages)
        expect(sent.match(/data:image\/webp;base64/g)).toHaveLength(3)
        expect(sent).toContain("Image not shown")
        expect(sent).toContain("keeping its number")
        const after = yield* store.context(session.id)
        expect(after.map((message) => message.type)).toEqual(["compaction", "user"])
        const carried = after[1]
        if (carried.type !== "user") throw new Error("expected the carried images")
        expect(carried.files).toHaveLength(1)
        expect(carried.files![0]).toMatchObject({ mime: "image/webp", data: "A".repeat(400) })
        // The next request: the summary, then image 4 with its line.
        const next = JSON.stringify(toLLMMessages(after, resolved.ref))
        expect(next.indexOf("the summary")).toBeLessThan(next.indexOf("[Image 4: shot.webp"))
        expect(next.match(/"mediaType":"image\/webp"/g)).toHaveLength(1)
      }),
    ),
  )
})

describe("other chats", () => {
  it.effect("keep today's cut of old images; a chat with optimized images never cuts one", () =>
    Effect.gen(function* () {
      const session = yield* insertSession(Session.ID.make("ses_image_other"))
      const prepared = yield* SessionModelRequest.Service
      // 30 MiB of images: past today's 25 MiB trigger, within 120 MB.
      const messages = Array.from({ length: 6 }, () => Message.user([image(5 * 1024 * 1024)]))
      const prepare = (images?: ImageFit.Model) =>
        prepared.primary({ session, agent: Agent.defaultID, model: resolved, system: [], messages, images })
      expect(JSON.stringify((yield* prepare()).request.messages)).toContain("This image was removed")
      expect((yield* prepare(opus)).request.messages).toEqual(messages)
    }),
  )

  it.effect("estimate images at 1,500 tokens; a chat with optimized images counts them exactly", () =>
    Effect.gen(function* () {
      const session = yield* insertSession(Session.ID.make("ses_image_estimate"))
      const webp = Buffer.from(
        yield* Effect.promise(async () => new Bun.Image(await gradient(1920, 1080)).webp().bytes()),
      )
      const messages = [user("look"), toolImages([{ line: "[Image 1]", data: webp.toString("base64") }])]
      const exact = SessionCompaction.estimatePrompt(loaded(session, messages))
      const today = SessionCompaction.estimatePrompt({ ...loaded(session, messages), images: undefined })
      expect(today.estimated - exact.estimated).toBe(1_500 - 2_691)
    }),
  )
})
