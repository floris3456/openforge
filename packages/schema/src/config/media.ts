export * as ConfigMedia from "./media.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Image extends Schema.Class<Image>("Config.Media.Image")({
  auto_resize: Schema.Boolean.pipe(optional),
  max_width: PositiveInt.pipe(optional),
  max_height: PositiveInt.pipe(optional),
  max_base64_bytes: PositiveInt.pipe(optional),
  opus_5_5: Schema.Boolean.pipe(optional).annotate({
    description:
      "openforge: images for Claude Opus 5.5 are sent at the most it reads, numbered, never changed once sent, with an image_zoom tool (default: false)",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Media")({
  image: Image.pipe(optional),
}) {}
