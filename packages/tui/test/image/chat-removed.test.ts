import { expect, test } from "bun:test"
import type { SessionMessageAssistantTool, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { PictureRemoved } from "@opencode/util/picture-removed"
import { chatImages, isRemovedPicture, toolImages, userImages } from "../../src/image/chat"

// openforge (spec pictures-files): a picture removed once its chat was untouched for 30 days shows as the placeholder
// where its line was, and the viewer skips it.

const png = "iVBORw0KGgo="
const LINE = "[Image 1: shot.png, 10×10, shown at 10×10; see it again or zoom with image]"

const user: SessionMessageUser = {
  id: "msg_user",
  type: "user",
  text: "look",
  time: { created: 0 },
  files: [
    { data: PictureRemoved.data, mime: "text/plain", name: "gone.png", source: { type: "inline" } },
    { data: png, mime: "image/png", name: "kept.png", source: { type: "inline" } },
    { data: btoa("notes"), mime: "text/plain", name: "notes.txt", source: { type: "inline" } },
  ],
}

const tool = {
  type: "tool",
  id: "prt_shot",
  name: "screenshot",
  time: { created: 0, completed: 1 },
  state: {
    status: "completed",
    input: {},
    content: [
      { type: "text", text: LINE },
      { type: "text", text: PictureRemoved.text },
      { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "kept.png" },
    ],
  },
} as unknown as SessionMessageAssistantTool

test("a removed picture is its placeholder where its line was, in a person's message and a tool's result", () => {
  expect(userImages(user)).toEqual([
    { key: "msg_user:0", uri: "", name: "gone.png", line: PictureRemoved.text, removed: true },
    { key: "msg_user:1", uri: `data:image/png;base64,${png}`, name: "kept.png" },
  ])
  expect(toolImages(tool)).toEqual([
    { key: "prt_shot:1", uri: "", line: PictureRemoved.text, removed: true },
    { key: "prt_shot:2", uri: `data:image/png;base64,${png}`, name: "kept.png" },
  ])
  expect(user.files?.map(isRemovedPicture)).toEqual([true, false, false])
})

test("the viewer goes through the pictures still there only", () => {
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    content: [tool],
  } as unknown as SessionMessageInfo
  expect(chatImages([user, assistant]).map((image) => image.key)).toEqual(["msg_user:1", "prt_shot:2"])
})
