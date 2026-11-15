import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import { contextLimit, loadRunReferences, runProviders } from "../../src/mini/catalog.shared"
import { catalogModel, catalogProvider } from "./fixture/catalog"

afterEach(() => {
  mock.restore()
})

describe("run catalog shared", () => {
  test("loads visible project references from the current reference catalog", async () => {
    const client = OpenCode.make({ baseUrl: "https://opencode.test" })
    const list = spyOn(client.reference, "list").mockImplementation(
      () =>
        Promise.resolve({
          location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
          data: [
            {
              name: "effect",
              path: "/repos/effect",
              description: "Effect v4 sources",
              source: { type: "local", path: "/repos/effect" },
            },
            {
              name: "secret",
              path: "/repos/secret",
              hidden: true,
              source: { type: "local", path: "/repos/secret" },
            },
          ],
        }) as never,
    )

    const references = await loadRunReferences(client, { directory: "/tmp" })

    expect(list).toHaveBeenCalledWith({ location: { directory: "/tmp" } })
    expect(references).toMatchObject([{ name: "effect", path: "/repos/effect", description: "Effect v4 sources" }])
  })

  test("merges current providers and models into the footer catalog shape", () => {
    const providers = runProviders(
      [catalogProvider("openai", "OpenAI")],
      [
        catalogModel({
          id: "gpt-5",
          modelID: "openai",
          providerID: "openai",
          name: "Little Frank",
          variants: ["high"],
        }),
      ],
    )

    expect(providers).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5": {
            name: "Little Frank",
            cost: {
              input: 0,
            },
            limit: {
              context: 128_000,
            },
            status: "active",
            variants: {
              high: {},
            },
          },
        },
      },
    ])
  })

  test("counts a step's context against the model's compaction point when it has one, else its window", () => {
    const pointed = catalogModel({ id: "pointed", providerID: "cpp", context: 1_000_000 })
    const providers = runProviders(
      [catalogProvider("cpp", "CLIProxyPacer")],
      [
        { ...pointed, limit: { ...pointed.limit, compact: 500_000 } },
        catalogModel({ id: "plain", providerID: "cpp", context: 200_000 }),
      ],
    )

    expect(providers[0]?.models.pointed?.limit).toEqual({ context: 1_000_000, compact: 500_000 })
    expect(contextLimit(providers, { providerID: "cpp", modelID: "pointed" })).toBe(500_000)
    // Without a point, as before: the model's window.
    expect(providers[0]?.models.plain?.limit).toEqual({ context: 200_000 })
    expect(contextLimit(providers, { providerID: "cpp", modelID: "plain" })).toBe(200_000)
    expect(contextLimit(providers, { providerID: "cpp", modelID: "unknown" })).toBeUndefined()
  })
})
