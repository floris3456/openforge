/** @jsxImportSource @opentui/solid */
import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { ShellInfo } from "@opencode/client"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { DialogShellOutput } from "../../src/component/dialog-shell-output"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider } from "../../src/context/route"
import { TuiAppProvider } from "../../src/context/runtime"
import { StorageProvider } from "../../src/context/storage"
import { ThemeProvider } from "../../src/context/theme"
import { Composer } from "../../src/routes/session/composer"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import type { ShellOutputRetry } from "../../src/util/shell-output"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch, createSseResponse, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/** Retries that wait until the test runs them. */
function retries() {
  const waiting: (() => void)[] = []
  const retry: ShellOutputRetry = (again) => {
    waiting.push(again)
    return () => {
      if (waiting.includes(again)) waiting.splice(waiting.indexOf(again), 1)
    }
  }
  return {
    retry,
    pending: () => waiting.length,
    run() {
      const again = waiting.shift()
      if (!again) throw new Error("no retry is waiting")
      again()
    },
  }
}

/** With `retry`, the viewer opens at once, as the shell tab opens it, but retrying when the test says. */
async function setup(width: number, output = "", retry?: ShellOutputRetry) {
  const temporary = await tmpdir()
  const location = { directory: `${temporary.path}/original` }
  const shell: ShellInfo = {
    id: "sh_fixture",
    command: "render-scene --quality high",
    cwd: location.directory,
    shell: "/bin/sh",
    file: `${temporary.path}/capture.out`,
    status: "running",
    metadata: { sessionID: "ses_fixture" },
    time: { started: 0 },
  }
  const state = { output, missing: false, failure: false }
  const requests: { url: URL; method: string }[] = []
  const events = createEventStream()
  const envelope = (data: unknown) => json({ location, data })
  type Watch = { stream: ReturnType<typeof createSseResponse>; cursor: number }
  const watches = new Set<Watch>()
  const watching = () => [...watches].filter((watch) => watch.stream.open)
  // What the server does: output from the watch's cursor as it arrives, then the end.
  const pump = (watch: Watch) => {
    const bytes = Buffer.from(state.output)
    if (watch.cursor < bytes.length)
      watch.stream.send({
        type: "output",
        output: bytes.subarray(watch.cursor).toString(),
        cursor: bytes.length,
        size: bytes.length,
        truncated: false,
      })
    watch.cursor = Math.max(watch.cursor, bytes.length)
    if (shell.status === "running") return
    watch.stream.send({ type: "exited", info: shell })
    watch.stream.close()
  }
  const watch = (cursor: number, signal: AbortSignal) => {
    const entry = { stream: createSseResponse(signal), cursor }
    watches.add(entry)
    pump(entry)
    return entry.stream.response
  }
  const api = createApi(
    createFetch((url, request) => {
      if (!url.pathname.startsWith("/api/shell") && !url.pathname.startsWith("/api/experimental/shell"))
        return undefined
      requests.push({ url, method: request.method })
      if (url.pathname === "/api/shell") return envelope([shell])
      if (state.missing)
        return json({ _tag: "ShellNotFoundError", id: shell.id, message: "Shell not found" }, { status: 404 })
      if (state.failure) return new Response("Unavailable", { status: 503 })
      if (url.pathname === `/api/shell/${shell.id}`) return envelope(shell)
      if (url.pathname === `/api/experimental/shell/${shell.id}/watch`)
        return watch(Number(url.searchParams.get("cursor") ?? 0), request.signal)
      const bytes = Buffer.from(state.output)
      const cursor = Math.min(Number(url.searchParams.get("cursor") ?? 0), bytes.length)
      const end = Math.min(cursor + Number(url.searchParams.get("limit") ?? 65536), bytes.length)
      return envelope({
        output: bytes.subarray(cursor, end).toString(),
        cursor: end,
        size: bytes.length,
        truncated: false,
      })
    }, events).fetch,
  )

  function Shells() {
    const data = useData()
    const dialog = useDialog()
    const [open, setOpen] = createSignal(true)
    onMount(() => {
      void data.shell.sync(location)
      if (retry) dialog.replace(() => <DialogShellOutput shell={shell} location={location} retry={retry} />)
    })
    return <Composer sessionID="ses_fixture" open={open()} defaultTab="shell" onClose={() => setOpen(false)} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <RouteProvider initialRoute={{ type: "session", sessionID: "ses_fixture" }}>
                <ClientProvider api={api}>
                  <DataProvider directory={temporary.path}>
                    <ThemeProvider mode={width === 40 ? "light" : "dark"} source={emptyThemeSource}>
                      <Keymap.Provider>
                        <ToastProvider>
                          <DialogProvider>
                            <Shells />
                          </DialogProvider>
                        </ToastProvider>
                      </Keymap.Provider>
                    </ThemeProvider>
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ConfigProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(shell.command))
  return {
    ...app,
    state,
    shell,
    location,
    requests,
    events,
    watching: () => watching().length,
    write(text: string) {
      state.output += text
      watching().forEach(pump)
    },
    exit(code: number) {
      shell.status = "exited"
      shell.exit = code
      watching().forEach(pump)
    },
    // The connection drops, and the server answers errors until it recovers.
    fail() {
      state.failure = true
      watching().forEach((watch) => watch.stream.fail(new Error("connection reset")))
    },
    // Removed while watched: the server ends the stream.
    remove() {
      state.missing = true
      watching().forEach((watch) => watch.stream.close())
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test.each([40, 100])("shell output opens, follows, scrolls, and survives exit at %s columns", async (width) => {
  await using app = await setup(width, Array.from({ length: 50 }, (_, i) => `Frame ${i + 1}\n`).join(""))
  expect(app.captureCharFrame()).toContain("output")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Shell output") && frame.includes("Frame 50"))
  const scroll = app.renderer.root.findDescendantById("shell-output-scroll")
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Output scrollbox missing")
  expect(scroll.scrollTop).toBeGreaterThan(0)

  app.mockInput.pressKey("HOME")
  await app.waitForFrame((frame) => frame.includes("Frame 1\n") || /Frame 1\s/.test(frame))
  expect(scroll.scrollTop).toBe(0)
  const height = scroll.scrollHeight
  app.write("Frame 51\n")
  await app.waitFor(() => scroll.scrollHeight > height, { maxPasses: 150 })
  expect(scroll.scrollTop).toBe(0)
  app.mockInput.pressKey("END")
  await app.waitForFrame((frame) => frame.includes("Frame 51"))
  // The command's last output comes before its end, on the same stream.
  app.write("\u001b[32mRender complete\u001b[0m\r\n")
  app.exit(0)
  app.events.emit({
    id: "evt_exit",
    created: 0,
    type: "shell.exited",
    location: app.location,
    data: { id: app.shell.id, exit: 0, status: "exited" },
  })
  await app.waitForFrame((frame) => frame.includes("Render complete") && frame.includes("code 0"), { maxPasses: 100 })
  expect(app.captureCharFrame()).not.toContain("[32m")
  expect(app.watching()).toBe(0)
  // Pushed, never polled: one size read and one watch.
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  const reads = app.requests.filter((request) => request.url.pathname !== "/api/shell")
  expect(reads.map((request) => request.url.pathname)).toEqual([
    `/api/shell/${app.shell.id}/output`,
    `/api/experimental/shell/${app.shell.id}/watch`,
  ])
  expect(reads.every((request) => request.url.searchParams.get("location[directory]") === app.location.directory)).toBe(
    true,
  )
  expect(reads.every((request) => request.url.searchParams.has("location[workspace]") === false)).toBe(true)

  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Shell output") && frame.includes("No shell commands"))
})

test("empty output explains redirection, reconnects after errors, and preserves output after removal", async () => {
  const later = retries()
  await using app = await setup(100, "", later.retry)
  await app.waitForFrame((frame) => frame.includes("No captured output") && frame.includes("redirected"))
  await app.waitFor(() => app.watching() === 1)
  app.fail()
  await app.waitForFrame((frame) => frame.includes("Retrying"), { maxPasses: 100 })
  expect(later.pending()).toBe(1)
  // Still failing: it tries again later, once.
  const count = app.requests.length
  later.run()
  await app.waitFor(() => later.pending() === 1)
  expect(app.requests.length).toBeGreaterThan(count)
  expect(app.captureCharFrame()).toContain("Retrying")
  app.state.failure = false
  later.run()
  // Back before any new output: reconnecting alone clears the error.
  await app.waitForFrame((frame) => !frame.includes("Retrying"), { maxPasses: 150 })
  await app.waitFor(() => app.watching() === 1)
  app.write("Recovered output\n")
  await app.waitForFrame((frame) => frame.includes("Recovered output"))
  // A stream that ends says nothing of why: the next read finds the command gone, and nothing is retried after it.
  app.remove()
  await app.waitFor(() => later.pending() === 1)
  later.run()
  await app.waitForFrame((frame) => frame.includes("no longer available"), { maxPasses: 150 })
  expect(app.captureCharFrame()).toContain("Recovered output")
  expect(later.pending()).toBe(0)
})

test("an ended command is not read again", async () => {
  const later = retries()
  await using app = await setup(100, "Done\n", later.retry)
  await app.waitForFrame((frame) => frame.includes("Done"))
  app.exit(0)
  await app.waitForFrame((frame) => frame.includes("code 0"), { maxPasses: 100 })
  expect(app.watching()).toBe(0)
  expect(later.pending()).toBe(0)
})

test("closing the viewer cancels a waiting retry", async () => {
  const later = retries()
  await using app = await setup(100, "Partial\n", later.retry)
  await app.waitForFrame((frame) => frame.includes("Partial"))
  app.fail()
  await app.waitFor(() => later.pending() === 1)
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Shell output"))
  expect(later.pending()).toBe(0)
})

test.each([40, 100])("mouse-wheel scrolling pauses and resumes output following at %s columns", async (width) => {
  await using app = await setup(width, Array.from({ length: 50 }, (_, i) => `Frame ${i + 1}\n`).join(""))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Shell output") && frame.includes("Frame 50"))
  const scroll = app.renderer.root.findDescendantById("shell-output-scroll")
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Output scrollbox missing")
  const bottom = scroll.scrollTop
  await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
  await app.waitFor(() => scroll.scrollTop < bottom)
  const paused = scroll.scrollTop
  const height = scroll.scrollHeight

  app.write("Frame 51\n")
  await app.waitFor(() => scroll.scrollHeight > height, { maxPasses: 100 })
  expect(scroll.scrollTop).toBe(paused)
  expect(app.captureCharFrame()).toContain("Shell output")

  await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "down")
  await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "down")
  await app.waitFor(() => scroll.scrollTop === scroll.scrollHeight - scroll.viewport.height)
  const followed = scroll.scrollTop
  app.write("Frame 52\n")
  await app.waitForFrame((frame) => frame.includes("Frame 52"), { maxPasses: 100 })
  expect(scroll.scrollTop).toBeGreaterThan(followed)
  expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.viewport.height)

  // Closing the viewer of a running command stops watching it.
  expect(app.watching()).toBe(1)
  app.mockInput.pressEscape()
  await app.waitFor(() => app.watching() === 0)
})

test("large captures open at a bounded tail and clicking a shell opens the viewer", async () => {
  await using app = await setup(100, "old output\n".repeat(20000) + "Latest frame\n")
  const row = app
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(app.shell.command))
  await app.mockMouse.click(6, row)
  await app.waitForFrame((frame) => frame.includes("Latest frame") && frame.includes("Earlier output omitted"))
  const reads = app.requests.filter((request) => request.url.pathname !== "/api/shell")
  expect(reads[0]?.url.pathname).toBe(`/api/shell/${app.shell.id}/output`)
  expect(reads[0]?.url.searchParams.get("cursor")).toBe(String(Number.MAX_SAFE_INTEGER))
  expect(reads[1]?.url.pathname).toBe(`/api/experimental/shell/${app.shell.id}/watch`)
  expect(reads[1]?.url.searchParams.get("cursor")).toBe(String(Buffer.byteLength(app.state.output) - 65536))
})
