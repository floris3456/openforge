import { ImageLine } from "@opencode/util/image-line"
import {
  mediaHashFromUri,
  type PromptAttachment,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
  type SessionMessageUser,
} from "@opencode/client"
import { imageInfo } from "@opentui/core"
import { deduplicateVisibleImages } from "../prompt/attachment"
import { toolDisplayContent } from "../util/tool-display"
import type { ViewerImage } from "./viewer"

// openforge (spec image-view): every image in a chat shows as the line the model got before it, at the image's place
// (an attached image in its message, a tool's image under that tool), and a click opens it in the viewer. The chat
// stores the bytes the model got, so the viewer shows the message's own file.
// The mini view writes the same lines into its scrollback.

/** An image of a chat: where it is, its bytes, and the line the model got before it, if it got one. */
export type ChatImage = {
  /** `<message id>:<file index>` for an attachment, `<part id>:<content index>` for a tool's image. */
  readonly key: string
  /** A `data:` URI or a `media:` ref. */
  readonly uri: string
  readonly name?: string
  readonly line?: string
}

/** An attached image's line is in its message's `metadata.imageLines`, by file index (set on arrival). */
export function userImages(message: SessionMessageUser): ChatImage[] {
  // Opted-in reads leave stored files as `media:` refs, a PromptAttachment variant the generated message type omits.
  const files: readonly PromptAttachment[] = message.files ?? []
  const lines = message.metadata?.imageLines
  return deduplicateVisibleImages<PromptAttachment>(files).flatMap((file) => {
    if (!file.mime.startsWith("image/")) return []
    const index = files.indexOf(file)
    const line = Array.isArray(lines) ? lines[index] : undefined
    return [
      {
        key: `${message.id}:${index}`,
        uri: "uri" in file ? file.uri : `data:${file.mime};base64,${file.data}`,
        ...(file.name !== undefined && { name: file.name }),
        ...(typeof line === "string" && { line }),
      },
    ]
  })
}

/** A tool's image's line is the text right before it in the tool's result. */
export function toolImages(part: SessionMessageAssistantTool): ChatImage[] {
  const content = toolDisplayContent(part.state)
  return content.flatMap((item, index) => {
    if (item.type !== "file" || !item.mime.startsWith("image/")) return []
    if (!item.uri.startsWith("data:image/") && !mediaHashFromUri(item.uri)) return []
    const before = content[index - 1]
    return [
      {
        key: `${part.id}:${index}`,
        uri: item.uri,
        ...(item.name && { name: item.name }),
        ...(before?.type === "text" && ImageLine.is(before.text) && { line: before.text }),
      },
    ]
  })
}

/** Every image of a chat, in order: what left and right go through in the viewer. */
export function chatImages(messages: readonly SessionMessageInfo[]): ChatImage[] {
  return messages.flatMap((message) => {
    if (message.type === "user") return userImages(message)
    if (message.type !== "assistant") return []
    return message.content.flatMap((part) => (part.type === "tool" ? toolImages(part) : []))
  })
}

/** The line an image without one shows: its name and size. */
export function fallbackLine(name: string | undefined, size?: { width: number; height: number }) {
  return `[Image: ${name ?? "image"}${size ? `, ${size.width}×${size.height}` : ""}]`
}

/** The viewer's images and where `key` is among them. */
export function viewerImages(images: readonly ChatImage[], key: string) {
  return {
    images: images.map(
      (image): ViewerImage => ({
        uri: image.uri,
        ...(image.line !== undefined && { line: image.line }),
        ...(image.name !== undefined && { name: image.name }),
      }),
    ),
    initial: Math.max(
      0,
      images.findIndex((image) => image.key === key),
    ),
  }
}

/** The size of an image in a `data:` URI, read now; for the mini view's scrollback, which is written once. */
export function dataImageSize(uri: string) {
  const bytes = dataBytes(uri)
  if (!bytes) return
  try {
    const info = imageInfo(bytes)
    return { width: info.width, height: info.height }
  } catch {
    return undefined
  }
}

/** The bytes of a `data:` URI. */
export function dataBytes(uri: string) {
  const comma = uri.indexOf(",")
  if (!uri.startsWith("data:") || comma === -1) return
  return Buffer.from(uri.slice(comma + 1), "base64")
}
