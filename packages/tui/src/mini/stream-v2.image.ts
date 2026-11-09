import type { SessionMessageAssistantTool, SessionMessageUser } from "@opencode/client/promise"
import { dataImageSize, fallbackLine, toolImages, userImages } from "../image/chat"
import type { StreamCommit } from "./types"

// openforge (spec image-view): an image shows in the scrollback as the line the model got before it, or its name and
// size; no thumbnail.

export type ImageCommit = StreamCommit & { image: string; messageID: string; partID: string }

export function userImageCommits(
  messageID: string,
  files: SessionMessageUser["files"],
  metadata?: SessionMessageUser["metadata"],
): ImageCommit[] {
  return userImages({ id: messageID, type: "user", text: "", time: { created: 0 }, files, metadata })
    .filter((image) => image.uri.startsWith("data:"))
    .map((image, index) => ({
      kind: "user",
      source: "system",
      text: image.line ?? fallbackLine(image.name, dataImageSize(image.uri)),
      image: image.uri,
      phase: "final",
      messageID,
      partID: `image:${index}`,
    }))
}

export function toolImageCommits(part: SessionMessageAssistantTool, messageID: string): ImageCommit[] {
  return toolImages(part)
    .filter((image) => image.uri.startsWith("data:image/"))
    .map((image, index) => ({
      kind: "tool",
      source: "tool",
      text: image.line ?? fallbackLine(image.name, dataImageSize(image.uri)),
      image: image.uri,
      phase: "final",
      messageID,
      partID: `prt_${part.id}:image:${index}`,
    }))
}
