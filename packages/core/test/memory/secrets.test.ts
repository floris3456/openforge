import { describe, expect, test } from "bun:test"
import { MemorySecrets } from "@opencode/core/memory/secrets"

// Built here rather than written out, so no secret scanner reads this file as holding one.
const fill = (length: number) => "Q7x".repeat(length).slice(0, length)

describe("MemorySecrets.find", () => {
  test("names the most exact kind of each known secret", () => {
    expect(
      [
        ["-----BEGIN OPENSSH PRIVATE", "KEY-----"].join(" "),
        ["sk", "ant", "api03", fill(24)].join("-"),
        ["sk", fill(24)].join("-"),
        "AIza" + fill(30),
        "ASIA" + "QX7Z".repeat(4),
        ["gho", fill(30)].join("_"),
        ["xoxp", fill(20)].join("-"),
        ["eyJ" + fill(20), "eyJ" + fill(20), fill(20)].join("."),
        `bearer ${fill(40)}`,
      ].map(MemorySecrets.find),
    ).toEqual([
      "private key",
      "Anthropic API key",
      "API key",
      "Google API key",
      "AWS access key",
      "GitHub token",
      "Slack token",
      "JSON web token",
      "bearer token",
    ])
  })

  test("leaves words about secrets, and short look-alikes, alone", () => {
    for (const text of [
      "Keys start with sk- and live in the credential store.",
      ["sk", fill(10)].join("-"),
      "AKIA" + "QX7Z".repeat(3),
      "a Bearer token is sent per request",
      "eyJ is how a base64 JSON object starts",
      "BEGIN PUBLIC KEY",
    ])
      expect(MemorySecrets.find(text)).toBeUndefined()
  })
})

describe("MemorySecrets.redact", () => {
  test("replaces each known secret with [secret] and leaves the rest as it was", () => {
    const key = ["sk", "ant", "api03", fill(24)].join("-")
    const token = ["ghp", fill(30)].join("_")
    expect(MemorySecrets.redact(`Use ${key}\nor ${token}, not ${key}.`)).toBe(
      "Use [secret]\nor [secret], not [secret].",
    )
    expect(MemorySecrets.redact(`Authorization: Bearer ${fill(40)}`)).toBe("Authorization: [secret]")
    expect(MemorySecrets.redact("Keys start with sk- and live in the credential store.")).toBe(
      "Keys start with sk- and live in the credential store.",
    )
  })

  test("takes a private key out with its body, to its end line or the end of the text", () => {
    const begin = ["-----BEGIN OPENSSH PRIVATE", "KEY-----"].join(" ")
    const end = ["-----END OPENSSH PRIVATE", "KEY-----"].join(" ")
    expect(MemorySecrets.redact(`before\n${begin}\n${fill(64)}\n${end}\nafter`)).toBe("before\n[secret]\nafter")
    expect(MemorySecrets.redact(`cut: ${begin}\n${fill(64)}`)).toBe("cut: [secret]")
  })
})
