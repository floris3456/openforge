export * as MemorySecrets from "./secrets.js"

// Known secret shapes an entry must not hold, checked before anything is sent. Started from http-recorder's list
// (`packages/http-recorder/src/redaction/secrets.ts`, a development package core does not import); the more specific
// patterns come first, so the kind named is the most exact one.
const patterns: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
]

/** The kind of the first known secret `text` holds, or undefined. */
export function find(text: string) {
  return patterns.find((item) => item.pattern.test(text))?.kind
}

/**
 * `text` with each known secret replaced by `[secret]`: for chat text memory keeps, which is not refused as an entry
 * is. A private key goes with its body, up to its end line or the end of the text.
 */
export function redact(text: string) {
  return patterns.reduce(
    (out, item) => out.replace(new RegExp(item.pattern.source, `${item.pattern.flags}g`), "[secret]"),
    text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[secret]"),
  )
}
