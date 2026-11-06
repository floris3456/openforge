import { CliRenderEvents, type CapturedFrame, type CliRenderer } from "@opentui/core"

/** One frame the renderer drew, as text and, when asked for, as colored spans. */
export interface RecordedFrame {
  /** `performance.now()` when the renderer drew it. */
  readonly at: number
  readonly text: string
  readonly spans?: CapturedFrame
}

/**
 * Records every frame the renderer draws, not only the ones a test captures after `renderOnce`. It listens to the
 * renderer's `frame` event, which fires once per frame it presents, whether a test asked for it (`renderOnce`,
 * `waitForFrame`) or the renderer scheduled it after a change (`requestRender`). So a state that lives for one frame
 * between two `renderOnce` calls is recorded too.
 */
export function recordFrames(
  setup: {
    readonly renderer: CliRenderer
    readonly captureCharFrame: () => string
    readonly captureSpans: () => CapturedFrame
  },
  options?: { readonly spans?: boolean },
) {
  const frames: RecordedFrame[] = []
  const listener = () =>
    frames.push({
      at: performance.now(),
      text: setup.captureCharFrame(),
      ...(options?.spans ? { spans: setup.captureSpans() } : {}),
    })
  setup.renderer.on(CliRenderEvents.FRAME, listener)
  return {
    frames,
    /** Frames drawn from now on. */
    mark() {
      const start = frames.length
      return () => frames.slice(start)
    },
    stop: () => setup.renderer.off(CliRenderEvents.FRAME, listener),
    [Symbol.dispose]: () => setup.renderer.off(CliRenderEvents.FRAME, listener),
  }
}

/** The lines of a frame between the first line containing `from` and the next containing `to` (both included). */
export function between(text: string, from: string, to?: string) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.includes(from))
  if (start < 0) return undefined
  const end =
    to === undefined ? lines.length - 1 : lines.findIndex((line, index) => index >= start && line.includes(to))
  return lines.slice(start, end < 0 ? lines.length : end + 1).join("\n")
}
