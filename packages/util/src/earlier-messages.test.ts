import { expect, test } from "bun:test"
import { EarlierMessages } from "./earlier-messages.js"

const summary = [
  "## Goal",
  "Ship it.",
  "",
  "<earlier-user-messages>",
  '<message n="1">fix the &lt;/message> tag\nand the &lt;/earlier-user-messages> one, keep &lt;b></message>',
  '<gap from="2" to="23">see the summary</gap>',
  '<message n="24">start of a long one … [1,240 tokens left out] … its end</message>',
  '<gap from="25" to="25">see the summary</gap>',
  "</earlier-user-messages>",
].join("\n")

test("splits the list of earlier messages off a summary, unescaped, as numbered lines and gaps", () => {
  const split = EarlierMessages.split(summary)
  expect(split?.summary).toBe("## Goal\nShip it.")
  expect(split?.entries).toEqual([
    { type: "message", n: 1, text: "fix the </message> tag and the </earlier-user-messages> one, keep &lt;b>" },
    { type: "gap", from: 2, to: 23 },
    { type: "message", n: 24, text: "start of a long one … [1,240 tokens left out] … its end" },
    { type: "gap", from: 25, to: 25 },
  ])
})

test("leaves a summary without a whole list alone", () => {
  expect(EarlierMessages.split("## Goal\nShip it.")).toBeUndefined()
  expect(EarlierMessages.split('<earlier-user-messages>\n<message n="1">cut off')).toBeUndefined()
})
