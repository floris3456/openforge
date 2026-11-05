export * as Seatbelt from "./seatbelt.js"

import type { Sandbox } from "./sandbox.js"

// The macOS Seatbelt profile for `/usr/bin/sandbox-exec -p`. It allows by default and denies what the policy refuses,
// each with `require-not`/`require-any` rather than an allow after a deny, so the order of the rules doesn't matter.
// Paths are resolved (/private/tmp, not /tmp): Seatbelt matches the real path.

export function profile(policy: Sandbox.Confinement) {
  return [
    "(version 1)",
    "(allow default)",
    policy.write.length ? `(deny file-write* (require-not ${any(policy.write)}))` : "(deny file-write*)",
    ...(policy.denyRead.length ? [`(deny file-read* ${any(policy.denyRead)})`] : []),
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
