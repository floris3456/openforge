import { expect, test } from "bun:test"
import { within } from "./wait"

// A wait that says only that it timed out hides what went wrong: under load web-tools' failed-search test failed with
// "no frame matched within 5 s" after 200 ms, when its check had thrown OpenTUI's OutputBusy.
test("within fails with the error its check threw, and checks no more", async () => {
  const thrown = new Error("the check threw")
  const checks = { count: 0 }
  const failed = await within(
    () => {
      checks.count++
      if (checks.count === 2) throw thrown
      return false
    },
    5_000,
    () => "timed out",
  ).catch((error: unknown) => error)
  expect(failed).toBe(thrown)
  expect(checks.count).toBe(2)
})

test("within fails with what failure() says once the time is up, written then", async () => {
  const checks = { count: 0 }
  const failed = await within(
    () => {
      checks.count++
      return false
    },
    50,
    () => `checked ${checks.count} times`,
  ).catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(Error)
  expect((failed as Error).message).toBe(`checked ${checks.count} times`)
  expect(checks.count).toBeGreaterThan(1)
})

test("within resolves once its check holds", async () => {
  const checks = { count: 0 }
  await within(() => ++checks.count === 3, 5_000, () => "timed out")
  expect(checks.count).toBe(3)
})
