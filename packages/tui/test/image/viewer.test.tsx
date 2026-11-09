/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { onMount } from "solid-js"
import { DialogImage, type ViewerImage } from "../../src/image/viewer"
import { useDialog } from "../../src/ui/dialog"
import { diffImageFixture } from "../fixture/diff-image"
import { commands, imageTerminal, placeholderCells, renderWithImages, transmitted, until } from "../fixture/image"

// openforge (spec image-view, Proof): the viewer shows exactly the bytes it is given, with their line as its title,
// fitted and never enlarged; left and right go through the images; Enter toggles actual size when the image is larger
// than the window, where the arrows move around it; Esc closes it. Cells are 9×20.

const small = `data:image/png;base64,${Buffer.from(diffImageFixture).toString("base64")}`
const large = `data:image/png;base64,${Buffer.from(
  await new Bun.Image(diffImageFixture).resize(2000, 1000, { filter: "nearest" }).png().bytes(),
).toString("base64")}`
const LINE_1 = "[Image 1: sun.png, 96×48, shown at 96×48; see it again or zoom with image]"
const LINE_2 = "[Image 2: big.png, 2000×1000, shown at 2000×1000; see it again or zoom with image]"
const images: ViewerImage[] = [
  { uri: small, title: LINE_1 },
  { uri: large, title: LINE_2 },
]

function Opener(props: { images: readonly ViewerImage[]; initial: number }) {
  const dialog = useDialog()
  onMount(() => dialog.replace(() => <DialogImage images={props.images} initial={props.initial} />))
  return <text>chat</text>
}

async function open(input: { placeholders: boolean; initial?: number; width?: number; height?: number }) {
  const terminal = imageTerminal({ placeholders: input.placeholders })
  const app = await renderWithImages(() => <Opener images={images} initial={input.initial ?? 0} />, terminal.terminal, {
    width: input.width ?? 100,
    height: input.height ?? 30,
  })
  return { app, ...terminal }
}

test.each([100, 60])(
  "an image smaller than the window is shown at its own size, never enlarged (%p columns)",
  async (width) => {
    const { app, sent } = await open({ placeholders: true, width })
    try {
      await until(app, () => placeholderCells(app.captureCharFrame()).length > 0)
      const frame = app.captureCharFrame()
      expect(frame).toContain("1 of 2 · 96×48")
      // The title may wrap around the dialog's "esc".
      expect(frame.replace(/\s+/g, " ").replace(" esc ", " ")).toContain(LINE_1)
      // 96×48 pixels are 10.7×2.4 cells: the box is 10×2, and the pixels sent fit it, 90×45 at most.
      expect(placeholderCells(frame)).toHaveLength(2)
      expect(placeholderCells(frame)[0]).toHaveLength(10)
      expect(commands(sent).at(-1)!.keys).toEndWith(",c=10,r=2")
      expect(Number(transmitted(sent)[0]!.keys.s)).toBeLessThanOrEqual(96)
      expect(frame).not.toContain("actual size")
    } finally {
      app.renderer.destroy()
    }
  },
)

test("left and right go through the images in order, round", async () => {
  const { app } = await open({ placeholders: true })
  try {
    await app.waitForFrame((frame) => frame.includes("1 of 2"))
    app.mockInput.pressArrow("right")
    await until(app, () => app.captureCharFrame().includes("2 of 2 · 2000×1000"))
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(LINE_2)
    app.mockInput.pressArrow("right")
    await until(app, () => app.captureCharFrame().includes("1 of 2"))
    app.mockInput.pressArrow("left")
    await until(app, () => app.captureCharFrame().includes("2 of 2"))
  } finally {
    app.renderer.destroy()
  }
})

test("Enter shows a larger image at actual size, the arrows move around it, and Enter fits it again", async () => {
  const { app, sent } = await open({ placeholders: true, initial: 1 })
  try {
    await until(app, () => placeholderCells(app.captureCharFrame()).length > 0)
    expect(app.captureCharFrame()).toContain("enter actual size")
    const fitted = placeholderCells(app.captureCharFrame())
    // The window holds 92×24 cells (100×30 less the dialog's edges, title and footer); 2000×1000 at 9×20 is 222.2×50
    // cells, so fitted it takes 92×20.
    expect(fitted).toHaveLength(20)
    expect(fitted[0]).toHaveLength(92)

    app.mockInput.pressEnter()
    await until(app, () => app.captureCharFrame().includes("fit to window") && transmitted(sent).length === 2)
    // Every pixel, padded to 223×50 cells: 2007×1000.
    expect(transmitted(sent)[1]!.keys).toMatchObject({ s: "2007", v: "1000" })
    await until(app, () => placeholderCells(app.captureCharFrame()).length === 24)
    expect(placeholderCells(app.captureCharFrame())[0]).toHaveLength(92)
    expect(placeholderCells(app.captureCharFrame())[0]![0]).toEqual([0, 0])

    // A quarter of the window a press: 23 columns, 6 rows.
    app.mockInput.pressArrow("right")
    await until(app, () => placeholderCells(app.captureCharFrame())[0]![0]![1] === 23)
    app.mockInput.pressArrow("down")
    await until(app, () => placeholderCells(app.captureCharFrame())[0]![0]![0] === 6)
    app.mockInput.pressArrow("left")
    await until(app, () => placeholderCells(app.captureCharFrame())[0]![0]![1] === 0)
    // At actual size the arrows don't switch images, and moving sends nothing.
    expect(app.captureCharFrame()).toContain("2 of 2")
    expect(transmitted(sent)).toHaveLength(2)
    for (let press = 0; press < 20; press++) app.mockInput.pressArrow("right")
    // As far as the image goes: its last column, 222, at the window's right edge.
    await until(app, () => placeholderCells(app.captureCharFrame())[0]!.at(-1)![1] === 222)

    app.mockInput.pressEnter()
    await until(app, () => app.captureCharFrame().includes("enter actual size"))
    await until(app, () => placeholderCells(app.captureCharFrame()).length === 20)
    app.mockInput.pressArrow("right")
    await until(app, () => app.captureCharFrame().includes("1 of 2"))
  } finally {
    app.renderer.destroy()
  }
})

test("Enter does nothing for an image the window holds", async () => {
  const { app, sent } = await open({ placeholders: true })
  try {
    await until(app, () => transmitted(sent).length === 1)
    app.mockInput.pressEnter()
    await app.renderOnce()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("fit to window")
    expect(transmitted(sent)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("Esc closes the viewer and deletes its image from the terminal", async () => {
  const { app, sent, terminal } = await open({ placeholders: true })
  try {
    await until(app, () => transmitted(sent).length === 1)
    const id = transmitted(sent)[0]!.keys.i
    app.mockInput.pressEscape()
    await until(app, () => !app.captureCharFrame().includes("1 of 2"))
    await terminal.drained()
    expect(sent.at(-1)).toBe(`\x1b_Ga=d,d=I,q=2,i=${id}\x1b\\`)
    expect(app.captureCharFrame()).toContain("chat")
  } finally {
    app.renderer.destroy()
  }
})

test("without placeholders OpenTUI draws the fitted image in a box of its own size", async () => {
  const { app, sent } = await open({ placeholders: false })
  try {
    await until(app, () => findImage(app.renderer.root)?.image?.width === 96)
    const image = findImage(app.renderer.root)!
    expect(image.id).toBe("image-viewer-image")
    expect([image.width, image.height]).toEqual([10, 2])
    expect(sent).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

function findImage(root: Renderable): ImageRenderable | undefined {
  if (root instanceof ImageRenderable) return root
  return root.getChildren().map(findImage).find(Boolean)
}
