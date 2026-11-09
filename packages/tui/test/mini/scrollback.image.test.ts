import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { RunScrollbackStream } from "../../src/mini/scrollback.surface"
import { toolImageCommits, userImageCommits } from "../../src/mini/stream-v2.image"
import { RUN_THEME_FALLBACK, RUN_THEME_MONO } from "../../src/mini/theme"
import type { StreamCommit } from "../../src/mini/types"
import { diffImageFixture } from "../fixture/diff-image"

// openforge (spec image-view): the mini view shows an image as the line the model got before it, or its name and size,
// and no thumbnail.

const wide = Buffer.from(diffImageFixture).toString("base64")
const LINE = "[Image 3: landscape.png, 96×48, shown at 96×48; see it again or zoom with image]"

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

async function setup(options: { mono?: boolean } = {}) {
  const renderer = await createTestRenderer({
    width: 100,
    height: 24,
    footerHeight: 6,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  const scrollback = new RunScrollbackStream(renderer.renderer, options.mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK, {
    mono: options.mono,
  })
  cleanups.push(() => {
    scrollback.destroy()
    renderer.renderer.destroy()
  })
  return { ...renderer, scrollback }
}

const rows = (out: Awaited<ReturnType<typeof setup>>) =>
  out.externalOutput
    .take()
    .filter((commit) => commit.text.trim())
    .map((commit) => commit.rows[0])

test("an attached image's commit is the line its message carries, else its name and size", () => {
  const files = [
    { data: wide, mime: "image/png", name: "landscape.png", source: { type: "inline" as const } },
    { data: wide, mime: "image/png", name: "copy.png", source: { type: "inline" as const } },
    { data: "AQID", mime: "image/png", name: "broken.png", source: { type: "inline" as const } },
  ]
  const commits = userImageCommits("msg_1", files, { imageLines: [LINE, null, null] })
  expect(commits.map((commit) => commit.text)).toEqual([LINE, "[Image: copy.png, 96×48]", "[Image: broken.png]"])
  expect(commits.map((commit) => commit.image)).toEqual([
    `data:image/png;base64,${wide}`,
    `data:image/png;base64,${wide}`,
    "data:image/png;base64,AQID",
  ])
})

test("a tool's image's commit is the line before it in the tool's result", () => {
  const part = {
    type: "tool",
    id: "prt_read",
    name: "read",
    time: { created: 0, completed: 1 },
    state: {
      status: "completed",
      input: {},
      content: [
        { type: "text", text: "Read landscape.png" },
        { type: "text", text: LINE },
        { type: "file", uri: `data:image/png;base64,${wide}`, mime: "image/png", name: "landscape.png" },
        { type: "file", uri: `data:image/png;base64,${wide}`, mime: "image/png", name: "again.png" },
      ],
    },
  } as unknown as SessionMessageAssistantTool
  expect(toolImageCommits(part, "msg_2").map((commit) => commit.text)).toEqual([LINE, "[Image: again.png, 96×48]"])
})

test.each([{}, { mono: true }])(
  "the scrollback shows each image as its line, in order with the text (%j)",
  async (options) => {
    const out = await setup(options)
    const image = (text: string, partID: string): StreamCommit => ({
      kind: "tool",
      source: "tool",
      tool: "read",
      phase: "final",
      messageID: "msg_1",
      partID,
      text,
      image: `data:image/png;base64,${wide}`,
    })
    await out.scrollback.append({ kind: "system", source: "system", phase: "final", text: "before images" })
    await out.scrollback.append(image(LINE, "image-1"))
    await out.scrollback.append(image("[Image: again.png, 96×48]", "image-2"))
    await out.scrollback.append({ kind: "system", source: "system", phase: "final", text: "after images" })
    await out.scrollback.complete()
    expect(rows(out)).toEqual(["before images", LINE, "[Image: again.png, 96×48]", "after images"])
  },
)

test("an attached image's line shows as the user's", async () => {
  const out = await setup()
  await out.scrollback.append({
    kind: "user",
    source: "system",
    phase: "final",
    messageID: "msg_1",
    partID: "image:0",
    text: LINE,
    image: `data:image/png;base64,${wide}`,
  })
  expect(rows(out)).toEqual([`\u203a ${LINE}`])
})
