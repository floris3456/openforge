// The filesystem reads that work out a policy and its rules. A read that fails (the path is missing, isn't a folder,
// or can't be searched) finds nothing instead of throwing: such a path has nothing to grant or deny.
import fs from "node:fs"
import path from "node:path"

/** The real path; for a path that doesn't exist yet, its deepest existing folder's real path plus the rest. */
export function real(file: string): string {
  const resolved = path.resolve(file)
  const found = attempt(() => fs.realpathSync.native(resolved))
  if (found !== undefined) return found
  const parent = path.dirname(resolved)
  return parent === resolved ? resolved : path.join(real(parent), path.basename(resolved))
}

export function entries(directory: string) {
  return attempt(() => fs.readdirSync(directory, { withFileTypes: true })) ?? []
}

export function text(file: string) {
  return attempt(() => fs.readFileSync(file, "utf8"))
}

/**
 * Whether `child` is `parent` or beneath it: `FSUtil.contains` of `@opencode/util`, which this package doesn't depend
 * on, since it loads Effect.
 */
export function inside(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
}

function attempt<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}
