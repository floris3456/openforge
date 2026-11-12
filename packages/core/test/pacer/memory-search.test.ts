import { describe, expect, test } from "bun:test"
import { words } from "./memory-search"

describe("memory search: a query's words", () => {
  test("outer punctuation is cut, words are lowercased", () => {
    expect(words(`"Where's" the (Release), Script?! — ok…`)).toEqual(["where's", "release", "script", "ok"])
  })

  test("stop words are dropped", () => {
    expect(words("how do I start a release from the shell")).toEqual(["start", "release", "shell"])
  })

  test("each word once", () => {
    expect(words("Release release RELEASE, release.")).toEqual(["release"])
  })

  test("identifiers, versions and paths stay whole", () => {
    expect(words("pings.duration_minutes in 0.0.24 at /pacer/v1/meters.")).toEqual([
      "pings.duration_minutes",
      "0.0.24",
      "/pacer/v1/meters",
    ])
    expect(words("(.env) -v --port _private")).toEqual([".env", "-v", "--port", "_private"])
  })

  test("pieces of punctuation only and stop words only leave no words", () => {
    expect(words(" -- ... / ")).toEqual([])
    expect(words("what is it")).toEqual([])
  })
})
