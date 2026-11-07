import { describe, expect, test } from "bun:test"
import { ReleaseVersion } from "../../src/upgrade/version"

describe("release versions", () => {
  test("orders releases by semver precedence", () => {
    const ordered = [
      "0.0.0",
      "0.0.1-alpha",
      "0.0.1-alpha.1",
      "0.0.1-alpha.beta",
      "0.0.1-beta",
      "0.0.1-beta.2",
      "0.0.1-beta.11",
      "0.0.1-rc.1",
      "0.0.1",
      "0.0.2",
      "0.0.9",
      "0.0.10",
      "0.1.0",
      "0.2.0",
      "0.10.0",
      "1.0.0",
      "18446744073709551616.0.0",
    ]
    ordered.slice(1).forEach((version, index) => {
      expect(ReleaseVersion.newer(version, ordered[index])).toBe(true)
      expect(ReleaseVersion.newer(ordered[index], version)).toBe(false)
    })
    expect(ReleaseVersion.newestFirst([...ordered].reverse().toSorted())).toEqual([...ordered].reverse())
  })

  test("treats a leading v and build metadata as the same release", () => {
    expect(ReleaseVersion.normalize("v0.0.1")).toBe("0.0.1")
    expect(ReleaseVersion.newer("0.0.1+build.5", "v0.0.1")).toBe(false)
    expect(ReleaseVersion.newer("v0.0.1", "0.0.1+other")).toBe(false)
  })

  test("rejects strings that are not versions", () => {
    for (const input of ["", "local", "1.2", "01.2.3", "1.2.3-01", "1.2.3-", "latest", "x".repeat(300)])
      expect(ReleaseVersion.normalize(input)).toBeUndefined()
    expect(ReleaseVersion.newer("local", "0.0.1")).toBe(false)
    expect(ReleaseVersion.newer("0.0.1", "local")).toBe(false)
    expect(ReleaseVersion.newestFirst(["0.0.1", ".install-abc", "0.0.2", "upgrade.json"])).toEqual(["0.0.2", "0.0.1"])
  })
})
