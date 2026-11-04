/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import type { UpdateOutcome, UpdateState } from "../../src/context/update-notification"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("upgrade progress replaces checking, waits for running chats and reports a rollback", async () => {
  await using temporary = await tmpdir()
  const [state, setState] = createSignal<UpdateState>()
  const pending = Promise.withResolvers<UpdateOutcome>()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate start={() => pending.promise} state={state} restart={() => {}} />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Checking for a new openforge release"))
    setState({ type: "installing", version: "0.0.1" })
    await app.waitForFrame((frame) => frame.includes("Installing openforge 0.0.1") && !frame.includes("Checking"))
    setState({ type: "ready", version: "0.0.1" })
    await app.waitForFrame((frame) => frame.includes("openforge 0.0.1 is ready; switches when no chat is running"))
    setState({ type: "switching", version: "0.0.1" })
    await app.waitForFrame((frame) => frame.includes("Switching to openforge 0.0.1"))
    const failure = "upgrade to 0.0.1 failed, back on 0.0.0: boom. Log: /data/log/upgrade.log"
    setState({ type: "failed", version: "0.0.1", message: failure })
    pending.reject(new Error(failure))
    await app.waitForFrame(
      (frame) => frame.includes("upgrade to 0.0.1 failed, back on 0.0.0") && !frame.includes("Switching"),
    )
    expect(app.captureCharFrame()).not.toContain("Restart")
  } finally {
    pending.resolve({ type: "current", version: "0.0.0" })
    app.renderer.destroy()
  }
})

test("a finished switch offers to restart this screen", async () => {
  await using temporary = await tmpdir()
  const [state] = createSignal<UpdateState>({ type: "switched", version: "0.0.1" })
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate state={state} restart={() => {}} />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("openforge 0.0.1 is running")
    expect(frame.toLowerCase()).toContain("restart")
  } finally {
    app.renderer.destroy()
  }
})
