import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { Tool } from "@opencode/core/tool"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Layer, Schema } from "effect"
import type { Info as ToolInfo } from "@opencode/schema/tool"
import { it } from "./lib/effect"

// A registry whose config the test holds, so no config on this machine decides what a catalog pins.
const toolNode = (entries: Parameters<typeof Config.testLayer>[0] = []) => {
  const config = Config.testLayer(entries)
  return Layer.merge(
    config,
    AppNodeBuilder.build(Tool.node, [
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      Config.node.replace(config),
    ]),
  )
}

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.namespace({ name: "empty", description: "No tools registered yet" })
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog).toStrictEqual({
        tools: [
          {
            type: "tool",
            name: "echo",
            description: "Echo text",
            signature: "tools.echo({\n  text: string,\n}): Promise<string>",
            pinned: true,
          },
          {
            type: "namespace",
            name: "empty",
            description: "No tools registered yet",
            tools: [],
          },
        ],
      })
    }).pipe(Effect.scoped, Effect.provide(toolNode())),
  )

  it.effect("renders Effect numbers in built-in tool signatures as number", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const ref = Schema.String.annotate({ identifier: "Ref", description: "Element ref" })
      const sentinel = Schema.Literals(["NaN", "Infinity", "-Infinity"])
      const Measure = {
        name: "measure",
        description: "Measure",
        input: Schema.Struct({ ref, amount: Schema.Number, sentinel }),
        output: Schema.Struct({ exit: Schema.optionalKey(Schema.Number), sentinel }),
        execute: () => Effect.succeed({ output: { exit: 0, sentinel: "NaN" as const } }),
      } satisfies ToolInfo<any, any>
      yield* tools.transform((editor) => {
        editor.add(Measure)
        editor.add({ ...Measure, name: "direct", options: { codemode: false } })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.codeModeCatalog?.tools).toEqual([
        {
          type: "tool",
          name: "measure",
          description: "Measure",
          signature: [
            "tools.measure({",
            "  /** Element ref */",
            "  ref: string,",
            "  amount: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}): Promise<{",
            "  exit?: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}>",
          ].join("\n"),
          pinned: false,
        },
      ])
      // Provider definitions keep Effect's plain JSON Schema encoding.
      const direct = JSON.stringify(snapshot.definitions.find((tool) => tool.name === "direct"))
      expect(direct).toContain('{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity","-Infinity","NaN"]}]}')
      expect(direct).not.toContain("$ref")
    }).pipe(Effect.scoped, Effect.provide(toolNode())),
  )
})

// `codemode.pinned` (workspace spec `docs/specs/codemode-pinning.md`): the person's config says whether a tool is
// always listed, by its catalog path or its namespace's `*`, and it wins over the tool's own registration.
describe("CodeMode pins", () => {
  /** One config document per map, from lowest to highest priority. */
  const pinned = (...maps: Array<Record<string, boolean>>) =>
    maps.map((pins) => new Document({ type: "document", info: new Info({ codemode: { pinned: pins } }) }))
  /** The listed entries when no budget is left: only the pinned ones are shown. */
  const listed = (catalog: CodeModeCatalog.Inventory | undefined) =>
    CodeModeCatalog.summarize(catalog!, { budget: 0 })
      .namespaces.flatMap((namespace) => namespace.entries.map((entry) => entry.path))
      .toSorted()
  const tool = (name: string, options?: Tool.Options): ToolInfo<any, any> => ({
    name,
    description: `${name} does something`,
    input: Schema.Struct({}),
    execute: () => Effect.succeed({ output: name }),
    ...(options === undefined ? {} : { options }),
  })
  const register = (tools: Tool.Interface) =>
    tools.transform((editor) => {
      editor.add(tool("web_search"))
      editor.add(tool("resolve-library-id", { namespace: "context7", codemode: true }))
      editor.add(tool("query-docs", { namespace: "context7", codemode: true }))
      // openforge's own, pinned by its registration as `openforge.worktree_list` is.
      editor.add(tool("worktree_list", { namespace: "openforge", codemode: true, pinned: true }))
    })

  it.effect("lists a tool its config names, and every tool of a namespace it names with `*`", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* register(tools)
      expect(listed((yield* tools.snapshot()).codeModeCatalog)).toEqual([
        "context7.query-docs",
        "context7.resolve-library-id",
        "openforge.worktree_list",
        "web_search",
      ])
    }).pipe(Effect.scoped, Effect.provide(toolNode(pinned({ web_search: true, "context7.*": true })))),
  )

  it.effect("unpins openforge's own pinned tool when the config says false", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* register(tools)
      const catalog = (yield* tools.snapshot()).codeModeCatalog!
      // Nothing is pinned, though `openforge.worktree_list` is by its registration; the budget still shows it.
      expect(listed(catalog)).toEqual([])
      expect(
        CodeModeCatalog.summarize(catalog, { budget: Infinity })
          .namespaces.flatMap((namespace) => namespace.entries)
          .some((item) => item.path === "openforge.worktree_list"),
      ).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(toolNode(pinned({ "openforge.worktree_list": false })))),
  )

  it.effect("merges every document's pins, a later document's value winning per tool", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* register(tools)
      // The person's pins stay, the project's add theirs and unpin openforge's exact path over the person's `openforge.*`.
      expect(listed((yield* tools.snapshot()).codeModeCatalog)).toEqual([
        "context7.query-docs",
        "context7.resolve-library-id",
        "web_search",
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        toolNode(
          pinned({ web_search: true, "openforge.*": true }, { "context7.*": true, "openforge.worktree_list": false }),
        ),
      ),
    ),
  )

  it.effect("reaches the catalog the registry keeps by identity when the config changes", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* register(tools)
      expect(listed((yield* tools.snapshot()).codeModeCatalog)).toEqual(["openforge.worktree_list"])
      const config = yield* Config.Test
      yield* config.setEntries(pinned({ web_search: true }))
      expect(listed((yield* tools.snapshot()).codeModeCatalog)).toEqual(["openforge.worktree_list", "web_search"])
    }).pipe(Effect.scoped, Effect.provide(toolNode())),
  )
})
