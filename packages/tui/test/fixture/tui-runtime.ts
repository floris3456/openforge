import { resolve, type Info, type Resolved } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"

type ResolvedInput = Omit<Info, "attention" | "keybinds" | "leader"> & {
  attention?: Partial<Omit<Resolved["attention"], "events">> & Pick<NonNullable<Info["attention"]>, "events">
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader?: { timeout?: number }
}

export function createTuiResolvedConfig(input: ResolvedInput = {}) {
  return resolve(input, { terminalSuspend: process.platform !== "win32", environment: {} })
}
