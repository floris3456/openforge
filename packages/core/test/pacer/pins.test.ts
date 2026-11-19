import { describe, expect, test } from "bun:test"
import path from "path"
import { PacerPins } from "@opencode/core/pacer/pins"

// What CPP is told of an agent's own Code Mode pins (`X-Pacer-Pins`): CPP's API.md, "Web tools", below the table.

const root = path.parse(process.cwd()).root
const home = path.join(root, "home", "floris")
const project = path.join(home, "theorysnap")
const decoded = (value: string | undefined) => JSON.parse(decodeURIComponent(value ?? "null"))
/** `count` pins, `pin_00` on, each with a `from` of `letters` characters. */
const many = (count: number, letters = 0) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `pin_${String(index).padStart(2, "0")}`,
      { pinned: true, ...(letters === 0 ? {} : { from: "f".repeat(letters) }) },
    ]),
  )

describe("PacerPins.of", () => {
  test("writes each file relative to the chat's project, else with the home folder as ~", () => {
    expect(
      PacerPins.of(
        {
          web_search: { pinned: true, from: path.join(project, ".opencode", "agent", "build.md") },
          recall: { pinned: false, from: path.join(project, "opencode.json") },
          "context7.*": { pinned: true, from: path.join(home, ".config", "openforge", "openforge.jsonc") },
          "openforge.*": { pinned: false, from: path.join(root, "etc", "openforge", "openforge.json") },
          task: { pinned: true },
        },
        { project, home },
      ),
    ).toEqual({
      web_search: { pinned: true, from: ".opencode/agent/build.md" },
      recall: { pinned: false, from: "opencode.json" },
      "context7.*": { pinned: true, from: "~/.config/openforge/openforge.jsonc" },
      "openforge.*": {
        pinned: false,
        from: `${path.join(root, "etc", "openforge", "openforge.json").split(path.sep).join("/")}`,
      },
      task: { pinned: true },
    })
  })
})

describe("PacerPins.header", () => {
  test("is the pins as percent-encoded JSON, in name order", () => {
    const header = PacerPins.header({
      web_search: { pinned: true, from: ".opencode/agent/build.md" },
      recall: { pinned: false, from: "opencode.json" },
      task: { pinned: true },
    })
    expect(header).toEqual({
      value: encodeURIComponent(
        '{"recall":{"pinned":false,"from":"opencode.json"},"task":{"pinned":true},"web_search":{"pinned":true,"from":".opencode/agent/build.md"}}',
      ),
      cut: false,
    })
  })

  test("is none without pins", () => {
    expect(PacerPins.header({})).toEqual({ cut: false })
  })

  test("keeps the first 32 tools by name", () => {
    const header = PacerPins.header(many(40))
    expect(Object.keys(decoded(header.value))).toEqual(Object.keys(many(PacerPins.TOOLS)))
    expect(header.cut).toBe(true)
    expect(PacerPins.header(many(PacerPins.TOOLS)).cut).toBe(false)
  })

  test("keeps a long file's last 300 characters, its name among them", () => {
    const from = `${"d/".repeat(200)}.opencode/agent/build.md`
    const header = PacerPins.header({ web_search: { pinned: true, from } })
    const sent: string = decoded(header.value).web_search.from
    expect([...sent]).toHaveLength(PacerPins.FROM)
    expect(sent).toBe(`…${from.slice(-(PacerPins.FROM - 1))}`)
    expect(header.cut).toBe(true)
    expect(PacerPins.header({ web_search: { pinned: true, from: "f".repeat(PacerPins.FROM) } }).cut).toBe(false)
  })

  test("leaves out the tools past 4 KB, keeping as many as fit", () => {
    const pins = many(PacerPins.TOOLS, 250)
    const header = PacerPins.header(pins)
    const kept = Object.keys(decoded(header.value))
    expect(header.value!.length).toBeLessThanOrEqual(PacerPins.BYTES)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(Object.keys(pins).slice(0, kept.length))
    // One more would not fit.
    expect(
      encodeURIComponent(JSON.stringify(Object.fromEntries(Object.entries(pins).slice(0, kept.length + 1)))).length,
    ).toBeGreaterThan(PacerPins.BYTES)
    expect(header.cut).toBe(true)
  })
})
