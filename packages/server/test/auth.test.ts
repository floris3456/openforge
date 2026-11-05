import { expect, test } from "bun:test"
import { ServerAuth } from "@opencode/server/auth"
import { Option, Redacted } from "effect"

test("accepts only the fixed openforge username, and opencode, which clients before 0.0.4 send", () => {
  const config = { password: Option.some("secret"), username: ServerAuth.USERNAME }
  expect(ServerAuth.USERNAME).toBe("openforge")
  expect(ServerAuth.authorized({ username: "openforge", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
  expect(ServerAuth.authorized({ username: "openforge", password: Redacted.make("wrong") }, config)).toBe(false)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("wrong") }, config)).toBe(false)
})

test("session tokens expire, resist tampering, and are revoked by changing the password", () => {
  const config = { password: Option.some("secret"), username: ServerAuth.USERNAME }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now)
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make(token) }, config)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now + ServerAuth.SESSION_TTL_SECONDS * 1000)).toBe(false)
  expect(ServerAuth.verifySession(`${token}x`, config, now)).toBe(false)
  const parts = token.split(".")
  expect(ServerAuth.verifySession(`${Number(parts[0]) + 1}.${parts[1]}`, config, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
  expect(ServerAuth.issueSession({ ...config, password: Option.none() })).toBeUndefined()
})
