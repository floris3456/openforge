import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, SubscriptionRef } from "effect"
import { Money } from "@opencode/schema/money"
import { Session as SessionInfo } from "@opencode/schema/session"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageFit } from "@opencode/core/image/fit"
import { PhotonNormalize } from "@opencode/core/image/photon-normalize"
import { Location } from "@opencode/core/location"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionBlob } from "@opencode/core/session/blob"
import { SessionTable } from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import { ImageTool } from "@opencode/core/tool/plugin/image"
import { definition } from "@opencode/core/tool/runtime"
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { noAncestors } from "./fixture/pacer-project"
import { testEffect } from "./lib/effect"
import { registerToolPlugin, toolIdentity } from "./lib/tool"
import { catalogOf } from "./memory/fixture"
import { endpointOf, fakeCpp, startTools } from "./pacer/fake-tools"

// Spec agent-notes, section 1, item 11: image.show({ task, item }) shows a review item's picture, read from
// CLIProxyPacer by its hash, so a lead marks exactly the picture handed in: whole, numbered as any image, with a text
// naming its round, place and own pixels; its comparison with compare; the bytes from the chat's own store once it
// holds them; and each refusal's words. CLIProxyPacer's two reads are a local server's. Offered only while the server's
// capabilities say it has review items (`pacer.memory.review_items`), so a release does not wait for its deploy; without
// them the tool is as it was before.

const opus = ImageFit.MODELS["claude-opus-5-5"]
const deepseek = ImageFit.MODELS["deepseek-v4.1-flash"]
const PROJECT = "proj-review"
const TASK = "t4sk00000001"

const photon = await PhotonNormalize.load()

/** A plain picture of this size and shade. */
const picture = async (width: number, height: number, shade: number) => {
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([shade, 40, 90, 255], i)
  const image = new photon.PhotonImage(pixels, width, height)
  const bytes = image.get_bytes()
  image.free()
  return bytes
}

const registryLayer = Layer.merge(
  Config.testLayer([new Document({ type: "document", info: new Info({ media: { image: { optimize: true } } }) })]),
  AppNodeBuilder.build(LayerNode.group([Tool.node, Database.node]), [
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  ]),
)
const it = testEffect(registryLayer)

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

/** openforge's own PacerProject for a folder outside git, as theorysnap's workspace is: its chats have no project. */
const outsideGit = PacerProject.layer.pipe(
  Layer.provide(
    Layer.succeed(
      Location.Service,
      Location.Service.of({
        directory: AbsolutePath.make("/root/theorysnap"),
        workspaceID: undefined,
        project: {
          id: Project.ID.make("2c63fe7b9185c1af3950e6f9e0e154b06f07677f"),
          directory: AbsolutePath.make("/root/theorysnap"),
          canonical: AbsolutePath.make("/root/theorysnap"),
        },
      }),
    ),
  ),
  Layer.provide(Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })),
  Layer.provide(noAncestors),
)

/** The chat as the store answers it, and its project as CLIProxyPacer names it (`projects`: another PacerProject). */
const services = (sessionID: Session.ID, projects?: Layer.Layer<PacerProject.Service>) =>
  Layer.mergeAll(
    Layer.mock(Session.Service, {
      get: () =>
        Effect.succeed(
          SessionInfo.Info.make({
            id: sessionID,
            projectID: Project.ID.global,
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
          }),
        ),
      revert: {
        stage: () => Effect.die("unused"),
        clear: () => Effect.die("unused"),
        commit: () => Effect.die("unused"),
      },
    }),
    projects ??
      Layer.succeed(
        PacerProject.Service,
        PacerProject.Service.of({
          chat: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
          session: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT }, repository: "/project" }),
          headers: () => ({ "X-Pacer-Project": PROJECT }),
        }),
      ),
  )

/** CLIProxyPacer's catalog in the test's hands, with or without review items; PacerModels over it. */
const catalogs = (reviewItems: boolean) =>
  Effect.gen(function* () {
    const at = (on: boolean) => catalogOf(true, { tools: true, goals: true, later: true, reviewItems: on })
    const ref = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(at(reviewItems))
    return {
      set: (on: boolean) => SubscriptionRef.set(ref, at(on)),
      layer: Layer.succeed(
        PacerModels.Service,
        PacerModels.Service.of({
          get: () => SubscriptionRef.get(ref),
          changes: () => SubscriptionRef.changes(ref),
          refresh: () => Effect.void,
        }),
      ),
    }
  })

/** image.show's definitions, each as SHA-256 of its JSON: as registered, and as a chat on Opus or DeepSeek gets it. */
const offered = Effect.gen(function* () {
  const registry = yield* Tool.Service
  const tool = (yield* registry.list()).find((item) => item.id === "image_show")!
  const shaped = {
    plain: tool,
    opus: ImageTool.variant(opus)!.tool(tool),
    deepseek: ImageTool.variant(deepseek)!.tool(tool),
  }
  return Object.fromEntries(
    Object.entries(shaped).map(([name, info]) => [
      name,
      new Bun.CryptoHasher("sha256").update(JSON.stringify(definition(info))).digest("hex"),
    ]),
  )
})

/** image.show's definitions on 3331bf5d6c, before review items: the tool without them is these, byte for byte. */
const BEFORE = {
  plain: "04a44bb4f936974b8686003fc9da46ef81745cba3d01d797635cce1e2929ac44",
  opus: "da32a3bd836b5c4f7b019668f92309f61d1fbb9e51071f1bc984cf21ceb21d45",
  deepseek: "c3521d80111211785ce377ae92f76242e4749483602200d681a8a87edee768c9",
}

/** The input fields image.show offers, as registered and as a chat on Opus gets it. */
const fields = Effect.gen(function* () {
  const registry = yield* Tool.Service
  const tool = (yield* registry.list()).find((item) => item.id === "image_show")!
  const keys = (info: typeof tool) => Object.keys(definition(info).inputSchema.properties ?? {})
  return { plain: keys(tool), opus: keys(ImageTool.variant(opus)!.tool(tool)), description: tool.description }
})

/** Waits, at most 5 s, until image.show's definitions are `wanted`: a change of the catalog reloads it. */
const offeredBecomes = (wanted: (hashes: Record<string, string>) => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 5_000
    while (!wanted(yield* offered)) {
      if (performance.now() > deadline) return yield* Effect.die(new Error("image.show never changed"))
      yield* Effect.sleep("5 millis")
    }
  })

/** A review item as CLIProxyPacer's client read answers it. */
const itemOf = (n: number, file: object | null, compare: object | null, extra: object = {}) => ({
  task: TASK,
  round: 3,
  n,
  kind: "picture",
  name: "after.png",
  file,
  compare,
  compare_name: compare ? "before.png" : null,
  ...extra,
})

const fileOf = (sha256: string, bytes: Uint8Array, width: number, height: number, mime = "image/png") => ({
  sha256,
  mime,
  bytes: bytes.byteLength,
  width,
  height,
})

/** image.show's answer for `input` in the chat, its picture arriving in the bank as a request has it arrive. */
const show = Effect.fnUntraced(function* (
  bank: { readonly db: Database.Interface["db"]; readonly sessionID: Session.ID },
  model: ImageFit.Model,
  input: Record<string, unknown>,
) {
  const registry = yield* Tool.Service
  const tool = (yield* registry.list()).find((item) => item.id === "image_show")!
  const result = yield* tool
    .execute(input, { ...toolIdentity, sessionID: bank.sessionID, id: Tool.CallID.make("call_review"), progress: () => Effect.void })
    .pipe(Effect.provideService(ImageBank.Current, { db: bank.db, sessionID: bank.sessionID, model }), Effect.result)
  if (result._tag === "Failure") return { error: result.failure.message }
  // the list's answer is a plain text
  if (typeof result.success.content === "string") return { text: result.success.content }
  const content = result.success.content ?? []
  const arrived = yield* ImageBank.arriveContent(bank.db, bank.sessionID, model, "image_show", content)
  return {
    text: content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
    file: content.find((item) => item.type === "file"),
    arrived: JSON.stringify(arrived),
  }
})

describe("image.show of a review item", () => {
  it.live("shows the item's picture whole, numbered, in its own pixels; its comparison; the bytes once", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      const after = yield* Effect.promise(() => picture(2400, 1600, 10))
      const before = yield* Effect.promise(() => picture(1200, 800, 200))
      const afterSha = SessionBlob.hashBytes(after)
      const beforeSha = SessionBlob.hashBytes(before)
      cpp.files.set(afterSha, { bytes: after, type: "image/png" })
      cpp.files.set(beforeSha, { bytes: before, type: "image/png" })
      cpp.answers.item = (request) =>
        request.path.endsWith("/items/2")
          ? Response.json(itemOf(2, fileOf(afterSha, after, 2400, 1600), fileOf(beforeSha, before, 1200, 800)))
          : Response.json({ error: { type: "not_found", message: `the latest round of ${TASK} has no item 9` } }, { status: 404 })
      const bank = yield* chat("ses_review_show")
      const catalog = yield* catalogs(true)
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID)),
        Effect.provide(catalog.layer),
      )

      const shown = yield* show(bank, opus, { task: TASK, item: 2 })
      expect(shown.text).toBe(
        `Task ${TASK}'s round 3, item 2, after.png: 2400×1600. Marks take these pixels: zoom into it by the number on its line and read them off the ruler.`,
      )
      expect(shown.arrived).toContain(`[Image 1: task ${TASK} item 2, after.png, 2400×1600, shown at`)
      // Asked for by the chat's project, with the chat named.
      const read = cpp.received.find((request) => request.path.includes("/items/"))!
      expect(read.path).toBe(`/pacer/v1/memory/${PROJECT}/tasks/${TASK}/items/2`)
      expect(read.headers.get("x-pacer-project")).toBe(PROJECT)
      expect(read.headers.get("x-pacer-session")).toBeTruthy()
      const gets = () => cpp.uploads.filter((request) => request.method === "GET").length
      expect(gets()).toBe(1)

      // Its comparison.
      const compared = yield* show(bank, opus, { task: TASK, item: 2, compare: true })
      expect(compared.text).toBe(
        `Task ${TASK}'s round 3, item 2's comparison, before.png: 1200×800. Marks take these pixels: zoom into it by the number on its line and read them off the ruler.`,
      )
      expect(compared.arrived).toContain(`[Image 2: task ${TASK} item 2's comparison, before.png, 1200×800`)
      expect(gets()).toBe(2)

      // Shown again, from the chat's own store, under its number: no download.
      const again = yield* show(bank, opus, { task: TASK, item: 2 })
      expect(again.arrived).toContain("[Image 1: ")
      expect(gets()).toBe(2)

      // Zoomed by its number, in its own pixels.
      const zoom = yield* show(bank, opus, { id: 1, zoom: { x: 0, y: 0, width: 100, height: 100 } })
      expect(zoom.text).toContain("of the original's pixels")

      // A model without the ruler is told how to read the pixels instead.
      const plain = yield* chat("ses_review_deepseek")
      const deep = yield* show(plain, deepseek, { task: TASK, item: 2 })
      expect(deep.text).toEndWith("zoom into it by the number on its line; each zoom says which of these pixels it shows.")

      // No such item: as the server says.
      expect(yield* show(bank, opus, { task: TASK, item: 9 })).toEqual({
        error: `CLIProxyPacer has no such item: the latest round of ${TASK} has no item 9`,
      })
    }).pipe(Effect.scoped),
  )

  it.live("refuses what has no picture to show, each with its reason", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      const gone = "a".repeat(64)
      const items: Record<string, object> = {
        "1": itemOf(1, null, null, { kind: "decision", name: "Keep it?" }),
        "2": itemOf(2, { sha256: "b".repeat(64), mime: "text/markdown", bytes: 10, lines: 42 }, null, {
          kind: "text",
          name: "spec.md",
        }),
        "3": itemOf(3, { sha256: gone, mime: "image/png", bytes: 10, width: 5, height: 5 }, null),
        "4": itemOf(4, { sha256: "c".repeat(64), mime: "image/svg+xml", bytes: 10, width: null, height: null }, null),
        "5": itemOf(
          5,
          { sha256: gone, mime: "image/png", bytes: 10, width: 5, height: 5 },
          { sha256: "d".repeat(64), mime: "text/markdown", bytes: 120, lines: 4 },
          { compare_name: "requirements.md" },
        ),
      }
      cpp.answers.item = (request) => Response.json(items[request.path.split("/").at(-1)!])
      const bank = yield* chat("ses_review_refused")
      const catalog = yield* catalogs(true)
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID)),
        Effect.provide(catalog.layer),
      )
      const refused = (input: Record<string, unknown>) => show(bank, opus, input).pipe(Effect.map((r) => r.error))
      expect(yield* refused({ task: TASK })).toBe("A review item needs its place too: image.show({ task, item }).")
      expect(yield* refused({ task: TASK, item: 1 })).toBe(`Item 1 of task ${TASK} is a decision: it has no picture.`)
      expect(yield* refused({ task: TASK, item: 2 })).toBe(`Item 2 of task ${TASK} is a text of 42 lines: mark it by its lines.`)
      expect(yield* refused({ task: TASK, item: 3, compare: true })).toBe(`Item 3 of task ${TASK} has no comparison.`)
      expect(yield* refused({ task: TASK, item: 3 })).toBe("Item 3's picture is no longer kept by CLIProxyPacer.")
      expect(yield* refused({ task: TASK, item: 4 })).toBe(
        `Item 4 of task ${TASK} is an SVG drawing, which image.show cannot show.`,
      )
      // A comparison that is a text is marked by its lines, never downloaded as a picture.
      const downloads = cpp.uploads.filter((request) => request.method === "GET").length
      expect(yield* refused({ task: TASK, item: 5, compare: true })).toBe(
        `Item 5 of task ${TASK}: its comparison is a text of 4 lines; mark it by its lines, with compare: true.`,
      )
      expect(cpp.uploads.filter((request) => request.method === "GET").length).toBe(downloads)
    }).pipe(Effect.scoped),
  )

  it.live("tells a chat outside git why it has no review items, and asks CLIProxyPacer nothing", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      const bank = yield* chat("ses_review_outside")
      const catalog = yield* catalogs(true)
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID, outsideGit)),
        Effect.provide(catalog.layer),
      )
      expect(yield* show(bank, opus, { task: TASK, item: 2 })).toEqual({
        error:
          "Review items are on CLIProxyPacer's task board. This chat's folder is not in a git repository, so it has no project, memory or task board. A chat started inside a git repository has one.",
      })
      expect(cpp.received.some((request) => request.path.includes("/items/"))).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live("without the server's review items, image.show is as it was before, byte for byte, and asks nothing", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCpp
      const started = yield* startTools(endpointOf(cpp.origin))
      const bank = yield* chat("ses_review_without")
      const catalog = yield* catalogs(false)
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID)),
        Effect.provide(catalog.layer),
      )
      expect(yield* offered).toEqual(BEFORE)
      expect((yield* fields).plain).toEqual(["id", "zoom"])
      // Asked for an item all the same: the list, as before, and nothing asked of the server.
      expect((yield* show(bank, opus, { task: TASK, item: 1 })).text).toBe("This chat has no images yet.")
      expect(cpp.received.some((request) => request.path.includes("/items/"))).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live("in a host without CLIProxyPacer, image.show is as it was before", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_review_none")
      yield* registerToolPlugin(ImageTool.Plugin)
      expect(yield* offered).toEqual(BEFORE)
      expect((yield* show(bank, opus, { task: TASK, item: 1 })).text).toBe("This chat has no images yet.")
    }).pipe(Effect.scoped),
  )

  it.live("with the server's review items, image.show offers task, item and compare, and follows the server", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_review_with")
      const catalog = yield* catalogs(true)
      yield* registerToolPlugin(ImageTool.Plugin).pipe(Effect.provide(services(bank.sessionID)), Effect.provide(catalog.layer))
      const offeredNow = yield* fields
      expect(offeredNow.plain).toEqual(["id", "zoom", "task", "item", "compare"])
      expect(offeredNow.opus).toEqual(["id", "zoom", "task", "item", "compare"])
      expect(offeredNow.description).toContain(
        "`image.show({ task, item })` shows a review item's picture (`compare: true` its comparison) in its own pixels, the ones the task tool's marks take.",
      )
      const hashes = yield* offered
      expect([hashes.plain, hashes.opus, hashes.deepseek].some((hash) => Object.values(BEFORE).includes(hash))).toBe(false)
      // The server no longer says so (another one connected): as before; and back.
      yield* catalog.set(false)
      yield* offeredBecomes((now) => now.plain === BEFORE.plain)
      expect(yield* offered).toEqual(BEFORE)
      yield* catalog.set(true)
      yield* offeredBecomes((now) => now.plain === hashes.plain)
      expect(yield* offered).toEqual(hashes)
    }).pipe(Effect.scoped),
  )
})
