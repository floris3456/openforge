import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { shows } from "./fixture/wait"

// A terminal hands the screen everything typed since its last read in one piece: keys typed while the screen is busy,
// or over a slow connection, come with the Enter after them. The composer hears of that text only after the Enter.
const read = (setup: { renderer: { stdin: NodeJS.EventEmitter } }, keys: string) =>
  setup.renderer.stdin.emit("data", Buffer.from(keys))

// The update dialog, open while the upgrade it started is still looking for a release.
const updating = (frame: string) => frame.includes("Checking for a new openforge release")

const updater = { subscribe: () => () => {}, upgrade: () => new Promise<never>(() => {}) }

test("a slash command read together with its Enter runs", async () => {
  await using setup = await createAppFixture({ updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  read(setup, "/update\r")
  await shows(setup, updating)
})

test("a slash command read with its Enter after the popup opened on the slash runs that command", async () => {
  await using setup = await createAppFixture({ updater })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  read(setup, "/")
  // The popup lists every command, the first one highlighted.
  await setup.waitForFrame((frame) => frame.includes("/agents"))
  read(setup, "update\r")
  await shows(setup, updating)
})

test("a command with arguments read with its Enter after the popup opened goes out with them", async () => {
  const sessionID = `ses_slash_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const commands: unknown[] = []
  await using setup = await createAppFixture({
    args: { sessionID },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Slash commands",
            agent: "build",
            model: { providerID: "demo", id: "model" },
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
        return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === "/api/command")
        return json({ location, data: [{ name: "review", description: "Review the changes" }] })
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/command`) {
        commands.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  read(setup, "/")
  await setup.waitForFrame((frame) => frame.includes("/agents"))
  read(setup, "review the diff\r")
  await shows(setup, () => commands.length > 0)
  expect(commands).toMatchObject([{ name: "review", text: "the diff" }])
})
