// Semantic version precedence (semver.org §11) for openforge release versions such as `0.0.1` or `v1.2.0-rc.1`.

const pattern =
  /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type Version = {
  readonly core: readonly [bigint, bigint, bigint]
  readonly prerelease: readonly string[]
}

export function parse(input: string): Version | undefined {
  if (input.length > 256) return
  const match = input.trim().match(pattern)
  if (!match) return
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  }
}

/** The version without a leading `v` or surrounding space, or undefined when it is not a semantic version. */
export function normalize(input: string) {
  if (!parse(input)) return
  return input.trim().replace(/^v/, "")
}

/** Negative when `left` precedes `right`, positive when it follows, 0 when they have the same precedence. */
export function compare(left: Version, right: Version): number {
  const core = left.core.findIndex((part, index) => part !== right.core[index])
  if (core !== -1) return left.core[core] < right.core[core] ? -1 : 1
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return right.prerelease.length - left.prerelease.length
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  const index = Array.from({ length }, (_, index) => index).find(
    (index) => left.prerelease[index] !== right.prerelease[index],
  )
  if (index === undefined) return 0
  const a = left.prerelease[index]
  const b = right.prerelease[index]
  if (a === undefined) return -1
  if (b === undefined) return 1
  const numericA = /^[0-9]+$/.test(a)
  const numericB = /^[0-9]+$/.test(b)
  if (numericA && numericB) return BigInt(a) < BigInt(b) ? -1 : 1
  if (numericA) return -1
  if (numericB) return 1
  return a < b ? -1 : 1
}

/** Whether `candidate` is a newer release than `than`; false when either is not a semantic version. */
export function newer(candidate: string, than: string) {
  const a = parse(candidate)
  const b = parse(than)
  if (!a || !b) return false
  return compare(a, b) > 0
}

/** Sorts version strings newest first; strings that are not versions are dropped. */
export function newestFirst(versions: ReadonlyArray<string>) {
  return versions
    .flatMap((version) => {
      const parsed = parse(version)
      return parsed ? [{ version, parsed }] : []
    })
    .sort((a, b) => compare(b.parsed, a.parsed))
    .map((item) => item.version)
}

export * as ReleaseVersion from "./version"
