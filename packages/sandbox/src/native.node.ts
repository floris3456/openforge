// Node has no FFI here: it can't confine, so `available()` reports no Landlock.
const unavailable = () => {
  throw new Error("the Linux sandbox needs Bun")
}

export const landlock = () => 0
export const seccomp = () => false
export const createRuleset: (fs: bigint, net: bigint) => number = unavailable
export const addPathRule: (ruleset: number, file: string, access: bigint) => boolean = unavailable
export const restrictSelf: (ruleset: number) => void = unavailable
export const installFilter: (program: Uint8Array) => void = unavailable
export const defaultSignals: (signals: readonly number[]) => void = unavailable
