import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Money } from "@opencode/schema/money"
import { Session as SessionInfo } from "@opencode/schema/session"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ImageBank } from "@opencode/core/image/bank"
import { ImageFit } from "@opencode/core/image/fit"
import { PhotonNormalize } from "@opencode/core/image/photon-normalize"
import { Location } from "@opencode/core/location"
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
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { registerToolPlugin, toolIdentity } from "./lib/tool"
import { endpointOf, fakeCpp, startTools } from "./pacer/fake-tools"

// Spec agent-notes, section 1, item 11: image.show({ task, item }) shows a review item's picture, read from
// CLIProxyPacer by its hash, so a lead marks exactly the picture handed in: whole, numbered as any image, with a text
// naming its round, place and own pixels; its comparison with compare; the bytes from the chat's own store once it
// holds them; and each refusal's words. CLIProxyPacer's two reads are a local server's.

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

/** The chat as the store answers it, and its project as CLIProxyPacer names it. */
const services = (sessionID: Session.ID) =>
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
    Layer.succeed(
      PacerProject.Service,
      PacerProject.Service.of({
        chat: () => Effect.succeed({ project: PROJECT, headers: { "X-Pacer-Project": PROJECT } }),
        headers: () => ({ "X-Pacer-Project": PROJECT }),
      }),
    ),
  )

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
  const content = typeof result.success.content === "string" ? [] : (result.success.content ?? [])
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
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID)),
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
      }
      cpp.answers.item = (request) => Response.json(items[request.path.split("/").at(-1)!])
      const bank = yield* chat("ses_review_refused")
      yield* registerToolPlugin(ImageTool.Plugin).pipe(
        Effect.provideService(PacerTools.Service, started.tools),
        Effect.provide(services(bank.sessionID)),
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
    }).pipe(Effect.scoped),
  )

  it.live("in a host without CLIProxyPacer, it says so", () =>
    Effect.gen(function* () {
      const bank = yield* chat("ses_review_none")
      yield* registerToolPlugin(ImageTool.Plugin)
      expect((yield* show(bank, opus, { task: TASK, item: 1 })).error).toBe(
        "Review items are on CLIProxyPacer, and this chat has no project there.",
      )
    }).pipe(Effect.scoped),
  )

  it.live("its description names the review item", () =>
    Effect.sync(() => {
      expect(ImageTool.DESCRIPTION).toContain(
        "`image.show({ task, item })` shows a review item's picture (`compare: true` its comparison) in its own pixels, the ones the task tool's marks take.",
      )
    }),
  )
})
