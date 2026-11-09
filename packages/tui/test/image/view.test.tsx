/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { ImageView } from "../../src/image/view"
import { diffImageFixture } from "../fixture/diff-image"
import { commands, imageTerminal, placeholderCells, renderWithImages, transmitted, until } from "../fixture/image"

// openforge (spec image-view, Proof): an image in a box of cells. Inside tmux with a terminal that draws placeholders,
// it is fitted to the box's pixels, sent through tmux, and drawn as placeholder cells in its number's colour; elsewhere
// OpenTUI draws it. The fixture is 96×48 pixels; cells are 9×20.

test("with placeholders, a fitted image is sent at the box's pixels and drawn as its cells", async () => {
  const images = imageTerminal({ placeholders: true })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="fit" width={10} height={4} />,
    images.terminal,
  )
  try {
    await until(app, () => placeholderCells(app.captureCharFrame()).length === 4)
    // 96×48 into 90×80 pixels: 90×45, centred in the box's 90×80 with transparent rows (17 above, 18 below), so the
    // terminal draws the pixels unscaled.
    const [image] = transmitted(images.sent)
    expect(image!.keys).toMatchObject({ a: "t", q: "2", f: "32", o: "z", s: "90", v: "80" })
    expect(image!.rgba.length).toBe(90 * 80 * 4)
    const alpha = (x: number, y: number) => image!.rgba[(y * 90 + x) * 4 + 3]
    expect([alpha(45, 16), alpha(45, 17), alpha(45, 61), alpha(45, 62)]).toEqual([0, 255, 255, 0])
    expect(commands(images.sent).at(-1)!.keys).toBe(`a=p,U=1,q=2,i=${image!.keys.i},c=10,r=4`)
    expect(placeholderCells(app.captureCharFrame())).toEqual(
      Array.from({ length: 4 }, (_, row) => Array.from({ length: 10 }, (_, column) => [row, column])),
    )
    // The cells' colour is the number's 256-colour index, which the image id is read from.
    const span = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("\u{10eeee}"))!
    expect(span.fg.intent).toBe("indexed")
    const id = Number(image!.keys.i)
    expect(id % 2 ** 24).toBe(span.fg.slot)
    expect(findImage(app.renderer.root)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a cover image fills the box and is cut to it", async () => {
  const images = imageTerminal({ placeholders: true })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="cover" width={10} height={4} />,
    images.terminal,
  )
  try {
    await until(app, () => transmitted(images.sent).length === 1)
    expect(transmitted(images.sent)[0]!.keys).toMatchObject({ s: "90", v: "80" })
  } finally {
    app.renderer.destroy()
  }
})

test("at actual size every pixel is kept, padded to whole cells, and the box shows the cells from its offset", async () => {
  const images = imageTerminal({ placeholders: true })
  const [offset, setOffset] = createSignal({ x: 3, y: 1 })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="actual" width={5} height={2} offset={offset()} />,
    images.terminal,
  )
  try {
    await until(app, () => placeholderCells(app.captureCharFrame()).length === 2)
    // 96×48 is 10.7×2.4 cells: a placement of 11×3 cells, 99×60 pixels, the image at one pixel per pixel.
    const [image] = transmitted(images.sent)
    expect(image!.keys).toMatchObject({ s: "99", v: "60" })
    expect(commands(images.sent).at(-1)!.keys).toEndWith(",c=11,r=3")
    // The padding is transparent.
    expect(image!.rgba[(0 * 99 + 98) * 4 + 3]).toBe(0)
    expect(image!.rgba[(59 * 99 + 0) * 4 + 3]).toBe(0)
    expect(image!.rgba[(0 * 99 + 0) * 4 + 3]).toBe(255)
    expect(placeholderCells(app.captureCharFrame())).toEqual([
      [
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [1, 7],
      ],
      [
        [2, 3],
        [2, 4],
        [2, 5],
        [2, 6],
        [2, 7],
      ],
    ])
    // Moving changes only the cells; nothing is sent again.
    const before = images.sent.length
    setOffset({ x: 100, y: 0 })
    await until(app, () => placeholderCells(app.captureCharFrame())[0]?.[0]?.[0] === 0)
    expect(placeholderCells(app.captureCharFrame())[0]).toEqual([
      [0, 6],
      [0, 7],
      [0, 8],
      [0, 9],
      [0, 10],
    ])
    expect(images.sent.length).toBe(before)
  } finally {
    app.renderer.destroy()
  }
})

test("an image that goes is deleted from the terminal", async () => {
  const images = imageTerminal({ placeholders: true })
  const [shown, setShown] = createSignal(true)
  const app = await renderWithImages(
    () => (
      <Show when={shown()}>
        <ImageView source={diffImageFixture} fit="fit" width={10} height={4} />
      </Show>
    ),
    images.terminal,
  )
  try {
    await until(app, () => transmitted(images.sent).length === 1)
    const id = Number(transmitted(images.sent)[0]!.keys.i)
    setShown(false)
    await app.renderOnce()
    await images.terminal.drained()
    expect(images.sent.at(-1)).toBe(`\x1b_Ga=d,d=I,q=2,i=${id}\x1b\\`)
    expect(placeholderCells(app.captureCharFrame())).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("a resize sends every image again", async () => {
  const images = imageTerminal({ placeholders: true })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="fit" width={10} height={4} />,
    images.terminal,
  )
  try {
    await until(app, () => transmitted(images.sent).length === 1)
    images.sent.length = 0
    images.renderer.emit("resize", 100, 30)
    await Bun.sleep(5)
    await images.terminal.drained()
    expect(transmitted(images.sent)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a client that shows placeholders attaching later turns an image drawn by OpenTUI into placeholder cells", async () => {
  const images = imageTerminal({
    placeholders: false,
    client: { termtype: "", passthrough: true },
    ask: async () => ({ termtype: "kitty(0.41.1)", passthrough: true, cell: { width: 9, height: 20 } }),
  })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="fit" width={10} height={4} />,
    images.terminal,
  )
  try {
    await until(app, () => findImage(app.renderer.root)?.image?.width === 96)
    expect(images.sent).toEqual([])
    images.renderer.emit("resize", 100, 30)
    await until(app, () => placeholderCells(app.captureCharFrame()).length === 4)
    expect(findImage(app.renderer.root)).toBeUndefined()
    expect(transmitted(images.sent)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("without placeholders OpenTUI draws the image and nothing is sent", async () => {
  const images = imageTerminal({ placeholders: false })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="fit" width={10} height={4} />,
    images.terminal,
  )
  try {
    await until(app, () => findImage(app.renderer.root)?.image?.width === 96)
    expect(findImage(app.renderer.root)?.protocol).toBe("auto")
    expect(images.sent).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("without placeholders, actual size draws the part of the image the box shows", async () => {
  const images = imageTerminal({ placeholders: false })
  const app = await renderWithImages(
    () => <ImageView source={diffImageFixture} fit="actual" width={5} height={2} offset={{ x: 3, y: 1 }} />,
    images.terminal,
  )
  try {
    await until(app, () => findImage(app.renderer.root)?.image !== null && findImage(app.renderer.root) !== undefined)
    // Five columns from column 3 and two rows from row 1, at 9×20: 45 pixels from x 27, and the 28 left from y 20.
    expect(findImage(app.renderer.root)!.image?.width).toBe(45)
    expect(findImage(app.renderer.root)!.image?.height).toBe(28)
  } finally {
    app.renderer.destroy()
  }
})

function findImage(root: Renderable): ImageRenderable | undefined {
  if (root instanceof ImageRenderable) return root
  return root.getChildren().map(findImage).find(Boolean)
}
