import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Attention } from "../src/attention"
import { optional } from "../src/schema"
import { SessionID } from "../src/session-id"

// openforge (notifications step 2): the wire to the players. A sound may name a built-in sound by ID; a player from
// before step 2, which knows only `name`, still reads the occurrence and plays its kind's sound.

// The shape of 0.0.14 and earlier, as such a player decodes it.
const OldSound = Schema.Struct({
  name: Schema.Literals(["done", "subagent_done", "question", "permission", "error", "default"]),
  file: Schema.String.pipe(optional),
})
const OldOccurrence = Schema.Struct({
  kind: Schema.Literals(["done", "subagent_done", "question", "permission", "error", "default"]),
  sessionID: SessionID.pipe(optional),
  title: Schema.String,
  message: Schema.String,
  notify: Schema.Boolean,
  sound: OldSound.pipe(optional),
  focused: Schema.Boolean,
})

const occurrence = {
  kind: "question",
  title: "openforge",
  message: "Permission needs input",
  notify: true,
  sound: { name: "question", id: "alert-04" },
  focused: false,
} as const

describe("Attention", () => {
  test("a sound names a built-in sound by its ID, one of the 45", () => {
    expect(Schema.decodeUnknownSync(Attention.Occurrence)(occurrence).sound).toEqual({
      name: "question",
      id: "alert-04",
    })
    expect(Attention.sounds).toHaveLength(45)
    expect(() => Schema.decodeUnknownSync(Attention.Sound)({ name: "done", id: "beep" })).toThrow()
  })

  test("an occurrence with an ID still decodes in the old shape, which plays its kind's sound", () => {
    const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(Attention.Occurrence)(occurrence)))
    expect(Schema.decodeUnknownSync(OldOccurrence)(encoded).sound).toEqual({ name: "question" })
  })

  test("reply is a kind, and a test can be asked of it", () => {
    expect(Schema.is(Attention.Kind)("reply")).toBe(true)
    expect(Attention.testKinds).toContain("reply")
  })

  test("each kind's built-in sound", () => {
    expect(Attention.kindSounds).toEqual({
      done: "bip-bop-01",
      reply: "bip-bop-01",
      default: "bip-bop-01",
      subagent_done: "yup-01",
      question: "bip-bop-03",
      permission: "bip-bop-03",
      error: "nope-03",
    })
  })
})
