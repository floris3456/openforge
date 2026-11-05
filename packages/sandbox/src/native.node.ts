// Node has no bun:ffi. `available()` says the sandbox needs Bun without probing, and every call here throws.
const unavailable = () => {
  throw new Error("the Linux sandbox needs Bun")
}

export const landlock: () => number = unavailable
export const seccomp: () => boolean = unavailable
export const createRuleset: (fs: bigint, net: bigint) => number = unavailable
export const addPathRule: (ruleset: number, file: string, access: bigint) => void = unavailable
export const noNewPrivileges: () => void = unavailable
export const restrictSelf: (ruleset: number) => void = unavailable
export const installFilter: (program: Uint8Array) => void = unavailable
export const defaultSignals: (signals: readonly number[]) => void = unavailable
