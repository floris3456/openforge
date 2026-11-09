import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { settings } from "../src/component/dialog-config"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { diffImageFixture } from "./fixture/diff-image"
import { directory, json } from "./fixture/tui-client"

// openforge (spec image-view, Proof): each image in a chat shows as the line the model got before it, at its place: an
// attached image in its message, a tool's image under that tool. An image without one shows its name and size. A click
// opens the viewer with the chat's images in order; there are no thumbnails, and the Transcript images setting is gone.

const png = Buffer.from(diffImageFixture).toString("base64")
const hash = "f".repeat(64)
const ATTACHED = "[Image 1: shot.png, 96×48, shown at 96×48; see it again or zoom with image]"
const READ = "[Image 2: sun.png, 96×48, shown at 96×48; see it again or zoom with image]"
const session = {
  id: "ses_images",
  title: "Images",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const user = (id: string, created: number, text: string, files: unknown[], metadata?: unknown) => ({
  type: "user",
  id,
  text,
  files,
  ...(metadata === undefined ? {} : { metadata }),
  time: { created },
})
// Newest first, as the server lists them.
const messages = [
  user("msg_ref", 6, "And this one", [
    { uri: `media:${hash}`, mime: "image/png", source: { type: "inline" }, name: "ref.png" },
  ]),
  user("msg_plain", 5, "Without optimized images", [
    { data: png, mime: "image/png", source: { type: "inline" }, name: "plain.png" },
  ]),
  {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 3, completed: 4 },
    content: [
      {
        type: "tool",
        id: "prt_read",
        name: "read",
        time: { created: 3, completed: 4 },
        state: {
          status: "completed",
          input: { filePath: `${directory}/sun.png` },
          content: [
            { type: "text", text: "Image read successfully" },
            { type: "text", text: READ },
            { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "sun.png" },
          ],
        },
      },
      { type: "text", text: "Looked at both" },
    ],
  },
  user(
    "msg_shot",
    1,
    "What is in [Image 1]",
    [
      {
        data: png,
        mime: "image/png",
        source: { type: "inline" },
        name: "shot.png",
        mention: { start: 11, end: 20, text: "[Image 1]" },
      },
      {
        data: Buffer.from("notes").toString("base64"),
        mime: "text/plain",
        source: { type: "inline" },
        name: "notes.txt",
      },
    ],
    { imageLines: [ATTACHED, null] },
  ),
]

async function openSession(config?: Config.Info) {
  const reads: string[] = []
  const app = await createAppFixture({
    width: 120,
    height: 50,
    config: { animations: false, tabs: { enabled: false }, ...config },
    args: { sessionID: session.id },
    fetch: async (url) => {
      const [, id, rest] = /^\/api\/(?:experimental\/)?session\/([^/]+)(.*)$/.exec(url.pathname) ?? []
      if (url.pathname === `/api/experimental/media/${hash}`) {
        reads.push(hash)
        return new Response(diffImageFixture, { headers: { "content-type": "image/png" } })
      }
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (id !== session.id) return undefined
      if (rest === "/message") return json({ data: messages, cursor: {} })
      if (rest === "") return json({ data: session })
      if (rest === "/inbox" || rest === "/permission") return json({ data: [] })
      if (rest === "/wait") return new Response(null, { status: 204 })
      return undefined
    },
  })
  await app.waitForFrame((frame) => frame.includes("Looked at both"))
  return Object.assign(app, { reads })
}

// The frame as one line, without the message borders.
const flat = (frame: string) => frame.replaceAll("┃", " ").replace(/\s+/g, " ")

test("every image shows as its line at its place, or its name and size, and no thumbnail", async () => {
  await using app = await openSession()
  await app.waitForFrame((frame) => flat(frame).includes("[Image: ref.png, 96×48]"))
  const frame = flat(app.captureCharFrame())
  // The attached image's line is in its message, after its text; a file that is no image keeps its chip.
  expect(frame).toContain(`What is in [Image 1] ${ATTACHED}`)
  expect(frame).toContain("file notes.txt")
  expect(frame).not.toContain("file shot.png")
  // The tool's image's line is under the tool.
  expect(frame).toContain(READ)
  // Without a line, the name and size: inline bytes are read at once, a media ref from the server once.
  expect(frame).toContain("[Image: plain.png, 96×48]")
  expect(app.reads).toEqual([hash])
  expect(findImages(app.renderer.root)).toEqual([])
}, 30_000)

test("a config that still sets Transcript images loads, and the setting does nothing", async () => {
  await using app = await openSession({ session: { image_preview: true } } as Config.Info)
  await app.waitForFrame((frame) => flat(frame).includes(ATTACHED))
  expect(findImages(app.renderer.root)).toEqual([])
  expect(settings.some((setting) => setting.path.join(".") === "session.image_preview")).toBe(false)
  expect(settings.some((setting) => setting.title === "Transcript images")).toBe(false)
}, 30_000)

test("clicking a line opens the viewer on that image, the chat's images in order around it, and Esc closes it", async () => {
  await using app = await openSession()
  await app.waitForFrame((frame) => flat(frame).includes(READ))
  const at = position(app.captureCharFrame(), "[Image 2: sun.png")
  await app.mockMouse.click(at.x + 2, at.y)
  await app.waitForFrame((frame) => frame.includes("2 of 4 · 96×48"))
  expect(flat(app.captureCharFrame())).toContain(READ)
  // The viewer shows the message's own bytes.
  await app.waitFor(() => {
    const image = app.renderer.root.findDescendantById("image-viewer-image")
    return image instanceof ImageRenderable && image.image?.width === 96
  })

  app.mockInput.pressArrow("left")
  await app.waitForFrame((frame) => frame.includes("1 of 4"))
  expect(flat(app.captureCharFrame())).toContain(ATTACHED)
  app.mockInput.pressArrow("right")
  app.mockInput.pressArrow("right")
  await app.waitForFrame((frame) => frame.includes("3 of 4"))
  expect(flat(app.captureCharFrame())).toContain("[Image: plain.png, 96×48]")

  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("3 of 4") && frame.includes("Looked at both"))
}, 30_000)

function findImages(root: Renderable): ImageRenderable[] {
  return [...(root instanceof ImageRenderable ? [root] : []), ...root.getChildren().flatMap(findImages)]
}

function position(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`${text} is not on screen`)
  return { x: lines[y]!.indexOf(text), y }
}
