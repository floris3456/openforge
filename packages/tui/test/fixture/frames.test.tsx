/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { recordFrames } from "./frames"
import { until } from "./wait"

// The recorder sees a state that lives for one frame between two renderOnce calls, which a test reading the frame
// after renderOnce never does: the proof that "every frame drawn" is every frame.
test("recordFrames records every frame drawn, also those no test waited for", async () => {
  const [text, setText] = createSignal("first")
  const app = await testRender(() => <text>{text()}</text>, { width: 20, height: 1 })
  try {
    await app.renderOnce()
    using recorder = recordFrames(app.renderer)
    setText("loading")
    // The renderer draws the change on its own; the test doesn't ask for it.
    await until(() => recorder.frames.length === 1, 2_000, "the loading frame")
    setText("second")
    await app.renderOnce()
    await until(() => recorder.frames.length === 2, 2_000, "the second frame")
    expect(recorder.missed).toBe(0)
    expect(recorder.frames.map((frame) => frame.text.trim())).toEqual(["loading", "second"])
    expect(app.captureCharFrame().trim()).toBe("second")
  } finally {
    app.renderer.destroy()
  }
})
