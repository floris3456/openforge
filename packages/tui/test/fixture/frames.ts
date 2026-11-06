import { CliRenderEvents, NativeError, NativeStatus, type CapturedLine, type CliRenderer } from "@opentui/core"

/** One frame the renderer drew, as text and as colored spans. */
export interface RecordedFrame {
  /** The renderer's frame number. */
  readonly id: number
  /** `performance.now()` when the renderer drew it. */
  readonly at: number
  readonly text: string
  readonly lines: readonly CapturedLine[]
}

/**
 * Records every frame the renderer draws, not only the ones a test captures after `renderOnce`. It listens to the
 * renderer's `frame` event, which fires once per frame it presents, whether a test asked for it (`renderOnce`,
 * `waitForFrame`) or the renderer scheduled it after a change (`requestRender`). So a state that lives for one frame
 * between two `renderOnce` calls is recorded too.
 *
 * The frame is read from the presented buffer's spans. While the native writer still flushes it, the read answers
 * OutputBusy; the recorder tries again until it reads, as long as no newer frame was drawn meanwhile. A frame it
 * could not read before the next one is counted in `missed`, so a check over the frames can't pass by not seeing one.
 */
export function recordFrames(target: { readonly renderer: CliRenderer } | CliRenderer) {
  const setup = "renderer" in target ? target : { renderer: target }
  const frames: RecordedFrame[] = []
  const state = { missed: 0 }
  const read = (id: number, at: number) => {
    if (setup.renderer.isDestroyed) return
    if (setup.renderer.frameId !== id) {
      state.missed++
      return
    }
    const lines = spans(setup.renderer)
    if (!lines) {
      setImmediate(() => read(id, at))
      return
    }
    frames.push({ id, at, lines, text: lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n") })
  }
  const listener = (event: { frameId: number }) => read(event.frameId, performance.now())
  setup.renderer.on(CliRenderEvents.FRAME, listener)
  const stop = () => setup.renderer.off(CliRenderEvents.FRAME, listener)
  return {
    frames,
    /** Frames drawn that the recorder could not read before the next one; a test over every frame needs 0. */
    get missed() {
      return state.missed
    },
    /** Frames drawn from now on. */
    mark() {
      const start = frames.length
      return () => frames.slice(start)
    },
    stop,
    [Symbol.dispose]: stop,
  }
}

function spans(renderer: CliRenderer) {
  try {
    return renderer.currentRenderBuffer.getSpanLines()
  } catch (error) {
    if (error instanceof NativeError && error.status === NativeStatus.OutputBusy) return undefined
    throw error
  }
}
