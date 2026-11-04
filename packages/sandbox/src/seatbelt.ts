export * as Seatbelt from "./seatbelt.js"

// The macOS Seatbelt profile for `/usr/bin/sandbox-exec -p`. It allows by default and denies what the policy refuses,
// each with `require-not`/`require-any` rather than an allow after a deny, so the order of the rules doesn't matter.
// Paths are resolved (/private/tmp, not /tmp): Seatbelt matches the real path.

export interface Policy {
  readonly write: readonly string[]
  readonly deny: readonly string[]
  readonly network: boolean
}

export function profile(policy: Policy) {
  return [
    "(version 1)",
    "(allow default)",
    policy.write.length ? `(deny file-write* (require-not ${any(policy.write)}))` : "(deny file-write*)",
    ...(policy.deny.length ? [`(deny file-read* ${any(policy.deny)})`] : []),
    // Unix sockets are not IP, so local services over them keep working.
    ...(policy.network ? [] : ['(deny network* (remote ip "*:*"))', '(deny network* (local ip "*:*"))']),
  ].join("\n")
}

function any(paths: readonly string[]) {
  return `(require-any ${paths.map((item) => `(subpath ${quote(item)})`).join(" ")})`
}

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}
