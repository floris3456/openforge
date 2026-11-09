export * as ImageBudget from "./budget.js"

import { type LLMRequest, type Media, Message } from "@opencode/ai/effect"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import type { Bus } from "../bus.js"
import type { SessionCompaction } from "../session/compaction.js"
import type { SessionContext } from "../session/context.js"
import { SessionEvent } from "../session/event.js"
import { SessionInbox } from "../session/inbox.js"
import { SessionMessage } from "../session/message.js"
import { ImageFit } from "./fit.js"
import { ImageLine } from "@opencode/util/image-line"

// The images of a chat with optimized images (spec images), request by request: never cut, replaced or changed once
// sent, so each request repeats the one before and only adds to it. Once what was sent leaves less room than one more
// full-size image, the model gets one note and the TUI one line; an image that would not fit makes the chat compact
// first, the summary written from what was already sent, and the images held back go out after it.

export interface Limits {
  readonly count: number
  readonly bytes: number
}

export const WARNING = "The next image will compact this chat first."
const NOTICE_SOURCE = "images"
const NOT_SHOWN =
  "[Image not shown: this chat's images fill what one request may carry. It is shown after the chat is compacted.]"
const CARRIED =
  "[These images arrived while this chat was compacted; they were not in the summary and are shown here for the first time.]"
const SUMMARY_IMAGES =
  "The conversation's images are numbered, each with a line such as `[Image 7: photo.jpg, …]` before it. Under Important Context, list every image as `Image <number>: <one line on what it showed>`, keeping its number, so the next agent can see any of them again with the image tool."

const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")

/**
 * The request's images, instead of `SessionModelRequest.boundImages`: in the order the history gained them while they
 * fit `limits`; from the first one that does not fit on, each is replaced where it arrives by a note, until a
 * compaction starts a new history. Each decision depends only on the images before it. Before a step the runner
 * compacts instead of leaving an image out, so only a compaction's own request, or a chat that doesn't compact
 * automatically, gets a note.
 */
export const bound = (messages: LLMRequest["messages"], limits: Limits) => {
  const state = { count: 0, bytes: 0, full: false }
  const place = (bytes: number) => {
    if (!state.full && state.count < limits.count && state.bytes + bytes <= limits.bytes) {
      state.count++
      state.bytes += bytes
      return true
    }
    state.full = true
    return false
  }
  const shaped = messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "media") {
        if (!isImage(part.media.mediaType)) return part
        return place(mediaBytes(part.media)) ? part : Message.text(NOT_SHOWN)
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return part
      const result = part.result
      const value = result.value.map((item): Tool.Content => {
        if (item.type !== "file" || !isImage(item.mime)) return item
        return place(uriBytes(item.uri)) ? item : { type: "text", text: NOT_SHOWN }
      })
      return same(value, result.value) ? part : { ...part, result: { ...result, value } }
    })
    return same(content, message.content) ? message : new Message({ ...message, content })
  })
  return same(shaped, messages) ? messages : shaped
}

const same = <T>(next: ReadonlyArray<T>, previous: ReadonlyArray<T>) =>
  next.length === previous.length && next.every((item, index) => item === previous[index])

const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return media.source.data.length
  if (media.source.type === "bytes") return ImageFit.base64Length(media.source.data.byteLength)
  return 0
}

/** The base64 payload of a `data:` URI; other URIs carry no inline bytes. */
const uriBytes = (uri: string) => (uri.startsWith("data:") ? uri.length - uri.indexOf(",") - 1 : 0)

const DATA_URI = /^data:[^,]*;base64,(.*)$/s

export interface Ledger {
  readonly count: number
  readonly bytes: number
  /** The images that did not fit, from the first one on, as they are stored, each with the line before it. */
  readonly held: ReadonlyArray<{ readonly line?: string; readonly data: string; readonly mime: string; readonly name?: string }>
  /** What fits leaves less room than one more full-size image. */
  readonly warn: boolean
}

/**
 * The images of a chat's history since its last compaction, counted as {@link bound} counts them: how many fit, their
 * bytes, the ones held back, and whether the next full-size image would not fit.
 */
export const ledger = (messages: ReadonlyArray<SessionMessage.Info>, model: ImageFit.Model, limits: Limits): Ledger => {
  const images = messages.flatMap((message) => {
    if (message.type === "user") {
      const lines = userLines(message)
      return (message.files ?? []).flatMap((file, index) =>
        isImage(file.mime) ? [{ line: lines[index], data: file.data, mime: file.mime, name: file.name }] : [],
      )
    }
    if (message.type !== "assistant") return []
    return message.content.flatMap((part) => {
      if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return []
      const content = part.state.content ?? []
      return content.flatMap((item, index) => {
        if (item.type !== "file" || !isImage(item.mime)) return []
        const data = DATA_URI.exec(item.uri)?.[1]
        if (data === undefined) return []
        const before = content[index - 1]
        return [
          {
            line: before?.type === "text" && ImageLine.is(before.text) ? before.text : undefined,
            data,
            mime: item.mime,
            name: item.name,
          },
        ]
      })
    })
  })
  const fitting = images.reduce(
    (state, image) =>
      state.full || state.count >= limits.count || state.bytes + image.data.length > limits.bytes
        ? { ...state, full: true }
        : { count: state.count + 1, bytes: state.bytes + image.data.length, full: false },
    { count: 0, bytes: 0, full: false },
  )
  const full = Math.min(model.bytesPerToken * model.tokens, limits.bytes)
  return {
    count: fitting.count,
    bytes: fitting.bytes,
    held: images.slice(fitting.count).map((image) => ({
      ...(image.line === undefined ? {} : { line: image.line }),
      data: image.data,
      mime: image.mime,
      ...(image.name === undefined ? {} : { name: image.name }),
    })),
    warn: fitting.count >= limits.count - 1 || limits.bytes - fitting.bytes < full,
  }
}

/** The lines a user message's images carry, by file index (`metadata.imageLines`, set on arrival). */
export const userLines = (message: { readonly metadata?: Record<string, unknown> }): ReadonlyArray<string | undefined> => {
  const lines = message.metadata?.imageLines
  if (!Array.isArray(lines)) return []
  return lines.map((value) => (typeof value === "string" ? value : undefined))
}

/** The summary prompt; a chat with optimized images asks to keep each image's number with one line on what it showed. */
export const summaryPrompt = (prompt: string, images: boolean) => (images ? `${prompt}\n\n${SUMMARY_IMAGES}` : prompt)

/** Before a step: true when the runner should load the context again, because it compacted or added the warning. */
export const before = Effect.fnUntraced(function* (input: {
  readonly loaded: SessionContext.Loaded & { readonly images: ImageFit.Model }
  readonly estimate: SessionCompaction.Estimate
  readonly compaction: SessionCompaction.Interface
  readonly bus: Bus.Interface
}) {
  const loaded = input.loaded
  const sessionID = loaded.session.id
  const counted = ledger(loaded.messages, loaded.images, ImageFit.requestLimits(loaded.images))
  // Only images that came with a step since the last compaction: compacting again could not make room for any other.
  if (counted.held.length > 0 && stepped(loaded.messages)) {
    const compacted = yield* input.compaction.compact({
      reason: "auto",
      context: loaded,
      estimate: input.estimate,
      images: true,
    })
    // Not compacted: the step goes out, the images that do not fit replaced by a note.
    if (compacted.status !== "completed") return false
    yield* carry(input.bus, sessionID, counted.held)
    return true
  }
  if (counted.held.length > 0 || !counted.warn || warned(loaded.messages)) return false
  yield* input.bus.publish(SessionEvent.Synthetic, {
    sessionID,
    text: WARNING,
    description: WARNING,
    metadata: { source: NOTICE_SOURCE },
  })
  return true
})

const stepped = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.some((message) => message.type === "assistant" && message.time.completed !== undefined)

const warned = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.some((message) => message.type === "synthetic" && message.metadata?.source === NOTICE_SOURCE)

/** The held images, after the summary, as one message with each image's line, as they arrived. */
const carry = (bus: Bus.Interface, sessionID: SessionContext.Loaded["session"]["id"], held: Ledger["held"]) => {
  const inboxID = SessionMessage.ID.create()
  return SessionInbox.serialized(
    sessionID,
    bus
      .publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID,
        item: {
          type: "user",
          delivery: "steer",
          payload: {
            text: CARRIED,
            files: held.map((image) => ({
              data: image.data,
              mime: image.mime,
              source: { type: "inline" as const },
              ...(image.name === undefined ? {} : { name: image.name }),
            })),
            metadata: { source: NOTICE_SOURCE, imageLines: held.map((image) => image.line ?? null) },
          },
        },
      })
      .pipe(Effect.andThen(bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID }))),
  )
}
