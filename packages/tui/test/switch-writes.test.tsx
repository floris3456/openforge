import { expect, test } from "bun:test"
import type { OpenCodeEvent, UpgradeState } from "@opencode/client"
import { takeDraft } from "../src/component/prompt/draft-stash"
import type { LogSink } from "../src/context/log"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { shows, until } from "./fixture/wait"

// Writes other than a prompt, sent from an open chat while openforge switches releases: the service refuses them as a
// paused new release does until the test brings it `up`, and records what it took.
function chat(options: { question?: boolean; transcript?: boolean } = {}) {
  // The draft stash is process-wide, so each test uses a fresh session for an empty composer.
  const sessionID = `ses_writes_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const state = {
    up: false,
    refused: [] as string[],
    taken: [] as { path: string; body: unknown }[],
    dismissed: false,
  }
  const form = {
    id: "frm_switch",
    sessionID,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Continue",
        description: "Carry on with the release?",
        options: [{ value: "Yes", label: "Yes" }],
      },
    ],
  }
  const switching = () =>
    json(
      { code: "service_switching", message: "switching, try again in 1 s" },
      { status: 503, headers: { "retry-after": "1" } },
    )
  const write = async (url: URL, request: Request, answer: () => Response) => {
    if (!state.up) {
      state.refused.push(url.pathname)
      return switching()
    }
    const text = await request.text()
    state.taken.push({ path: `${request.method} ${url.pathname}`, body: text ? JSON.parse(text) : undefined })
    return answer()
  }
  const messages = options.transcript
    ? [
        {
          type: "assistant",
          id: "msg_b",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          finish: "stop",
          time: { created: 2, completed: 3 },
          content: [{ type: "text", text: "Here is the plan." }],
        },
        { type: "user", id: "msg_a", text: "The first line of this chat", time: { created: 1 } },
      ]
    : []
  const fetch = async (url: URL, request: Request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Switch writes",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/form` && request.method === "GET")
      return json({ data: options.question && !state.dismissed ? [form] : [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    if (url.pathname === "/api/command")
      return json({ location, data: [{ name: "review", description: "Review the changes" }] })
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/model`)
      return write(url, request, () => new Response(null, { status: 204 }))
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/shell`)
      return write(url, request, () => new Response(null, { status: 204 }))
    if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/command`)
      return write(url, request, () => new Response(null, { status: 204 }))
    if (request.method === "DELETE" && url.pathname === `/api/session/${sessionID}/form/${form.id}`)
      return write(url, request, () => {
        state.dismissed = true
        return new Response(null, { status: 204 })
      })
    return undefined
  }
  const taken = (suffix: string) => state.taken.filter((write) => write.path.endsWith(suffix))
  return { sessionID, state, fetch, taken }
}

const resumed = { id: "evt_resumed", created: Date.now(), type: "service.resumed", data: {} } as OpenCodeEvent

// An updater another screen's switch reports through, which records the restarts it is asked for, and a log that
// says each time the restart was due but held back, with how many writes the service had not answered then.
function restarts() {
  const listeners = new Set<(state: UpgradeState) => void>()
  const relaunches: Array<string | undefined> = []
  const held: number[] = []
  const heard = new Set<() => void>()
  const log: LogSink = (_level, message, tags) => {
    if (!message.startsWith("the restart waits")) return
    held.push(typeof tags.unanswered === "number" ? tags.unanswered : -1)
    heard.forEach((listener) => listener())
  }
  return {
    relaunches,
    held,
    log,
    /** Resolves once the restart has been held back `count` times in all, or it ran. */
    holds: (count: number) =>
      new Promise<void>((resolve) => {
        const listener = () => {
          if (held.length < count && relaunches.length === 0) return
          heard.delete(listener)
          resolve()
        }
        heard.add(listener)
        listener()
      }),
    switched: (version: string) => listeners.forEach((notify) => notify({ type: "switched", version })),
    updater: {
      subscribe: (notify: (state: UpgradeState) => void) => {
        listeners.add(notify)
        return () => listeners.delete(notify)
      },
      upgrade: async () => ({ type: "current" as const, version: "0.1.1" }),
      relaunch: (sessionID?: string) => {
        relaunches.push(sessionID)
        heard.forEach((listener) => listener())
      },
    },
  }
}

test("a `!` command typed while the new release is paused runs once it resumes, with the same id", async () => {
  const fake = chat()
  await using setup = await createAppFixture({ fetch: fake.fetch, args: { sessionID: fake.sessionID } })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("!")
  await setup.mockInput.typeText("git status")
  setup.mockInput.pressEnter()
  await until(() => fake.state.refused.some((path) => path.endsWith("/shell")))
  fake.state.up = true
  setup.events.emit(resumed)
  await until(() => fake.taken("/shell").length > 0)
  // Refused once, then resent once on the resume.
  expect(fake.state.refused.filter((path) => path.endsWith("/shell"))).toHaveLength(1)
  const shells = fake.taken("/shell")
  expect(shells).toHaveLength(1)
  expect(shells[0]?.body).toMatchObject({ command: "git status", id: expect.stringMatching(/^msg_/) })
  expect(setup.captureCharFrame()).not.toContain("Failed to")
}, 15_000)

test("a slash command typed while the new release is paused runs once it resumes, with its id", async () => {
  const fake = chat()
  await using setup = await createAppFixture({ fetch: fake.fetch, args: { sessionID: fake.sessionID } })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("/review the diff")
  await shows(setup, (frame) => frame.includes("/review the diff"))
  setup.mockInput.pressEnter()
  // The composer's model selection goes first, then the command.
  await until(() => fake.state.refused.length > 0)
  fake.state.up = true
  setup.events.emit(resumed)
  await until(() => fake.taken("/command").length > 0)
  const commands = fake.taken("/command")
  expect(commands).toHaveLength(1)
  expect(commands[0]?.body).toMatchObject({ name: "review", text: "the diff", id: expect.stringMatching(/^msg_/) })
  expect(setup.captureCharFrame()).not.toContain("Failed to")
}, 15_000)

test("a question dismissed while the new release is paused is dismissed once it resumes", async () => {
  const fake = chat({ question: true })
  await using setup = await createAppFixture({ fetch: fake.fetch, args: { sessionID: fake.sessionID } })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Carry on with the release?"))
  setup.mockInput.pressEscape()
  await until(() => fake.state.refused.some((path) => path.endsWith("/form/frm_switch")))
  fake.state.up = true
  setup.events.emit(resumed)
  await until(() => fake.taken("/form/frm_switch").length > 0)
  await shows(setup, (frame) => !frame.includes("Carry on with the release?"))
  expect(fake.state.refused.filter((path) => path.endsWith("/form/frm_switch"))).toHaveLength(1)
  expect(fake.taken("/form/frm_switch")).toHaveLength(1)
  expect(setup.captureCharFrame()).not.toContain("not dismissed")
}, 15_000)

test("a `!` command the service does not take within the limit goes back in the composer and says so", async () => {
  const fake = chat()
  await using setup = await createAppFixture({
    fetch: fake.fetch,
    args: { sessionID: fake.sessionID },
    resendLimit: 300,
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("!")
  await setup.mockInput.typeText("make release")
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Shell command not sent"))
  await shows(setup, (frame) =>
    frame.includes(
      "openforge did not take it within 300 ms; it was switching releases or could not be reached. It is back in the composer",
    ),
  )
  expect(setup.captureCharFrame()).toContain("make release")
  expect(setup.captureCharFrame()).not.toContain("Failed to run shell command")
  expect(fake.taken("/shell")).toEqual([])
}, 15_000)

test("a slash command the service does not take within the limit is reported as a command not sent", async () => {
  const fake = chat()
  await using setup = await createAppFixture({
    fetch: fake.fetch,
    args: { sessionID: fake.sessionID },
    resendLimit: 300,
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("/review the diff")
  await shows(setup, (frame) => frame.includes("/review the diff"))
  setup.mockInput.pressEnter()
  await shows(setup, (frame) => frame.includes("Command not sent") && frame.includes("within 300 ms"))
  expect(setup.captureCharFrame()).toContain("/review the diff")
  expect(fake.taken("/command")).toEqual([])
}, 15_000)

test("a screen told the switch finished restarts only once its waiting writes went in", async () => {
  takeDraft(undefined)
  const fake = chat()
  const restart = restarts()
  await using setup = await createAppFixture({
    fetch: fake.fetch,
    args: { sessionID: fake.sessionID },
    updater: restart.updater,
    log: restart.log,
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("!")
  await setup.mockInput.typeText("git status")
  setup.mockInput.pressEnter()
  await until(() => fake.state.refused.some((path) => path.endsWith("/shell")))
  // Another screen's switch finished; the new release has not resumed yet, so the command still waits.
  restart.switched("0.1.1")
  await restart.holds(1)
  expect(restart.held).toEqual([1])
  expect(restart.relaunches).toEqual([])
  fake.state.up = true
  setup.events.emit(resumed)
  await until(() => restart.relaunches.length > 0)
  expect(fake.taken("/shell")).toHaveLength(1)
  expect(restart.relaunches).toEqual([fake.sessionID])
}, 15_000)

test("a screen told the switch finished does not restart while a write is still on its way", async () => {
  takeDraft(undefined)
  const fake = chat()
  // The new release has just started: it takes the composer's model selection, then answers the command slowly.
  let answer: (() => void) | undefined
  const fetch = async (url: URL, request: Request) => {
    if (fake.state.up && request.method === "POST" && url.pathname === `/api/session/${fake.sessionID}/command`)
      await new Promise<void>((resolve) => (answer = resolve))
    return fake.fetch(url, request)
  }
  const restart = restarts()
  await using setup = await createAppFixture({
    fetch,
    args: { sessionID: fake.sessionID },
    updater: restart.updater,
    log: restart.log,
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("/review the diff")
  await shows(setup, (frame) => frame.includes("/review the diff"))
  setup.mockInput.pressEnter()
  // The selection goes first and waits to be resent; the command is sent once the selection is taken.
  await until(() => fake.state.refused.some((path) => path.endsWith("/model")))
  restart.switched("0.1.1")
  await restart.holds(1)
  fake.state.up = true
  setup.events.emit(resumed)
  await until(() => answer !== undefined)
  expect(fake.taken("/model")).toHaveLength(1)
  // Restarting now would cut the command off on its way; nothing would bring it back. Each change of the writes on
  // their way makes the restart due again, and it is held back while the command waits for its answer.
  const held = restart.held.length
  try {
    await restart.holds(held + 1)
    expect(restart.held.at(-1)).toBe(1)
    expect(restart.relaunches).toEqual([])
  } finally {
    // Also when the check fails, so the fixture's server can stop.
    answer!()
  }
  await until(() => restart.relaunches.length > 0)
  expect(fake.taken("/command")).toHaveLength(1)
  expect(restart.relaunches).toEqual([fake.sessionID])
}, 15_000)

test("the switch notice leaves the first lines of a chat visible", async () => {
  const fake = chat({ transcript: true })
  fake.state.up = true
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    fetch: fake.fetch,
    args: { sessionID: fake.sessionID },
    config: { animations: false, tabs: { enabled: false } },
  })
  await setup.ready
  await shows(setup, (frame) => frame.includes("The first line of this chat") && frame.includes("Here is the plan."))
  const before = setup.captureCharFrame().split("\n")
  const first = before.findIndex((line) => line.includes("The first line of this chat"))
  setup.events.emit({
    id: "evt_pausing",
    created: Date.now(),
    type: "service.pausing",
    data: { deadline: Date.now() + 120_000, waiting: [{ sessionID: fake.sessionID, kind: "tool", name: "webfetch" }] },
  } as OpenCodeEvent)
  await shows(setup, (frame) => frame.includes('waiting for webfetch in "Switch writes"'))
  const lines = setup.captureCharFrame().split("\n")
  const notice = lines.findIndex((line) => line.includes("Switching to a new openforge release"))
  const moved = lines.findIndex((line) => line.includes("The first line of this chat"))
  // The transcript makes room below the notice instead of running under it.
  expect(moved).toBeGreaterThan(notice)
  expect(moved).toBeGreaterThanOrEqual(first)
  expect(lines.join("\n")).toContain("Here is the plan.")
}, 15_000)
