import { describe, expect, test } from "bun:test"
import { retryWait } from "../../src/util/retry-wait"

const noLogin = {
  type: "provider.rate-limit",
  message: "auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5)",
  status: 503,
}

describe("retryWait", () => {
  test("names a wait for a free login and its time left", () => {
    expect(retryWait({ attempt: 2, at: 252_000, error: noLogin }, 0)).toBe("waiting for a free login · retry in 4m 12s")
    expect(
      retryWait(
        {
          attempt: 2,
          at: 9_000,
          error: {
            type: "provider.rate-limit",
            message: "All credentials are cooling down",
            status: 429,
            response: { body: '{"error":{"code":"model_cooldown"}}' },
          },
        },
        0,
      ),
    ).toBe("waiting for a free login · retry in 9s")
  })

  test("names any other retry by its time left and attempt", () => {
    expect(
      retryWait(
        { attempt: 3, at: 11_200, error: { type: "provider.internal", message: "Overloaded", status: 529 } },
        0,
      ),
    ).toBe("retry in 12s · attempt 3")
    expect(
      retryWait({ attempt: 3, at: 1_000, error: { type: "provider.internal", message: "Overloaded" } }, 5_000),
    ).toBe("retry due · attempt 3")
  })
})
