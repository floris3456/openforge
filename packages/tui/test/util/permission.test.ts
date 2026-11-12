import { expect, test } from "bun:test"
import { permissionAlwaysLines, permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(
    permissionPresentation({ action: "unsandboxed", resources: ["make install"], input: { command: "make install" } }),
  ).toMatchObject({ title: "Run outside the sandbox", lines: ["$ make install"] })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

// Spec image-tools, item 4: image.generate asks under opencode's action; from a program its input is the program's.
test("image generation asks to generate an image, with the prompt and the model", () => {
  expect(
    permissionPresentation({
      action: "experimental_image_generate",
      resources: ["cliproxypacer/gpt-image-2"],
      input: { code: "return await tools.image.generate({ prompt: 'a red square' })" },
      metadata: { prompt: "a red square", model: "cliproxypacer/gpt-image-2", images: ["in.png"], path: "out.png" },
      tool: "execute",
    }),
  ).toEqual({
    icon: "◇",
    title: "Generate an image",
    lines: ["Prompt: a red square", "Model: cliproxypacer/gpt-image-2", "From 1 image", "Saved to out.png"],
  })
  expect(
    permissionPresentation({ action: "experimental_image_generate", resources: ["test/painter"], metadata: {} }).lines,
  ).toEqual(["Model: test/painter"])
  expect(permissionAlwaysLines({ action: "experimental_image_generate", save: ["*"] })).toEqual([
    "This will always allow image generation for this project.",
  ])
  expect(permissionAlwaysLines({ action: "webfetch", save: ["*"] })).toEqual([
    "This will always allow webfetch for this project.",
  ])
})
