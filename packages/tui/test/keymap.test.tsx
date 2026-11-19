/** @jsxImportSource @opentui/solid */
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { useKeymap } from "@opentui/keymap/solid"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          "session.page.up": "pgup",
          "session.page.down": "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("returns every formatted command shortcut", async () => {
  let read = () => [] as readonly string[]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [{ id: "demo.command", bind: "x,y", run() {} }],
    }))
    read = () => shortcuts.list("demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

test("re-registered commands keep their opencode object until its data changes", async () => {
  const [title, setTitle] = createSignal("Demo")
  const [description, setDescription] = createSignal<string | undefined>("Runs the demo")
  const [version, setVersion] = createSignal(0)
  let opencode = () => undefined as KeymapCommand | undefined
  let command = () => undefined as KeymapCommand | undefined

  function Harness() {
    const keymap = useKeymap()
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "demo.command",
          title: title(),
          ...(description() === undefined ? {} : { description: description() }),
          palette: true,
          suggested: version() >= 0,
          run() {},
        },
      ],
    }))
    opencode = () =>
      keymap.getCommandEntries({ visibility: "registered" }).find((entry) => entry.command.name === "demo.command")
        ?.command.opencode
    command = () => commands().find((item) => item.id === "demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    const first = opencode()
    setVersion(1)
    expect(opencode()).toBe(first)

    setTitle("Renamed")
    expect(opencode()).not.toBe(first)
    expect(command()?.title).toBe("Renamed")

    setDescription(undefined)
    expect(command()?.description).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("re-registered commands keep inline slash objects until their fields change", async () => {
  const [aliases, setAliases] = createSignal(["d"])
  const [version, setVersion] = createSignal(0)
  let registered = () => undefined as { opencode?: unknown; slash?: unknown } | undefined
  let command = () => undefined as KeymapCommand | undefined

  function Harness() {
    const keymap = useKeymap()
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "demo.slash",
          title: "Demo",
          suggested: version() >= 0,
          slash: { name: "demo", aliases: aliases(), arguments: true },
          run() {},
        },
      ],
    }))
    registered = () =>
      keymap.getCommandEntries({ visibility: "registered" }).find((entry) => entry.command.name === "demo.slash")
        ?.command
    command = () => commands().find((item) => item.id === "demo.slash")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    const first = registered()
    setVersion(1)
    expect(registered()?.opencode).toBe(first?.opencode)
    expect(registered()?.slash).toBe(first?.slash)

    setAliases(["d", "dm"])
    expect(registered()?.opencode).not.toBe(first?.opencode)
    expect(command()?.slash?.aliases).toEqual(["d", "dm"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})

test("a command run by a key sequence that replaces a keyed screen mounts the next screen once and disposes the last", async () => {
  // Found in the pilotty run of cpp-next (tui-1): <leader>o and <leader>1 moving to another chat mounted its session
  // route twice and kept one of them alive. OpenTUI's keymap ran the command with the sequence still pending, so a
  // layer leaving with the old screen checked the other layers' `enabled`, and one reading a memo of the old screen made
  // Solid run the keyed <Show> again inside its own disposal.
  const mounts: string[] = []
  const cleanups: string[] = []
  const [screen, setScreen] = createSignal("a")

  function Screen(props: { id: string }) {
    mounts.push(props.id)
    onCleanup(() => cleanups.push(props.id))
    const shown = createMemo(() => screen())
    const label = createMemo(() => `${shown()}!`)
    Keymap.createLayer(() => ({
      enabled: () => label() !== "",
      commands: [{ id: `screen.${props.id}.one`, run() {} }],
    }))
    Keymap.createLayer(() => ({ commands: [{ id: `screen.${props.id}.two`, run() {} }] }))
    return <text>screen {props.id}</text>
  }

  function Harness() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "screen.next", bind: "<leader>o", run: () => void setScreen("b") }],
    }))
    return (
      <Show when={screen()} keyed>
        {(id) => <Screen id={id} />}
      </Show>
    )
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(mounts).toEqual(["a"])
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("o")
    await app.renderOnce()
    expect(screen()).toBe("b")
    expect({ mounts, cleanups }).toEqual({ mounts: ["a", "b"], cleanups: ["a"] })
  } finally {
    app.renderer.destroy()
  }
})
