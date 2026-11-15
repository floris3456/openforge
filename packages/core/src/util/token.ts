export * as Token from "./token.js"

export const CHARS_PER_TOKEN = 4

export const estimate = (input: string, charsPerToken = CHARS_PER_TOKEN) =>
  Math.max(0, Math.round(input.length / charsPerToken))
