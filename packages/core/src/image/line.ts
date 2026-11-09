export * as ImageLine from "./line.js"

// The line before an optimized image (spec images), fixed on arrival. Its own module, so places that only need to
// recognize it, such as the runner's cut of long tool output, don't load the bank.

/** The line for image `number`, its name, original size and the size it is shown at. */
export const make = (
  number: number,
  name: string,
  image: {
    readonly width: number
    readonly height: number
    readonly shown: { readonly width: number; readonly height: number }
  },
) =>
  `[Image ${number}: ${name}, ${image.width}×${image.height}, shown at ${image.shown.width}×${image.shown.height}; see it again or zoom with image]`

const LINE = /^\[Image \d+: .*; see it again or zoom with image\]$/s

/** Whether a text is such a line. */
export const is = (text: string) => LINE.test(text)
