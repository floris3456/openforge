import type { ContinuityWork } from "./promise/generated/types.js"

/**
 * What a release switch waits for, in words: `a reply in "Fix the tests", webfetch in "Docs"`. A chat's model call is
 * its reply, so a chat in the middle of one is named once. `title` gives a chat's title; a chat without one is "an
 * untitled chat".
 */
export function describeWork(
  waiting: ReadonlyArray<ContinuityWork>,
  title: (sessionID: string) => string | undefined = () => undefined,
) {
  const seen = new Set<string>()
  return waiting
    .flatMap((work) => {
      const what =
        work.kind === "tool"
          ? work.name
          : work.kind === "step" && work.name !== "reply"
            ? "a step"
            : work.sessionID
              ? "a reply"
              : "a model call"
      const key = `${work.sessionID ?? ""} ${what}`
      if (seen.has(key)) return []
      seen.add(key)
      if (!work.sessionID) return [what]
      const name = title(work.sessionID)
      return [`${what} in ${name ? `"${name}"` : "an untitled chat"}`]
    })
    .join(", ")
}
