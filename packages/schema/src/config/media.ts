export * as ConfigMedia from "./media.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Image extends Schema.Class<Image>("Config.Media.Image")({
  auto_resize: Schema.Boolean.pipe(optional),
  max_width: PositiveInt.pipe(optional),
  max_height: PositiveInt.pipe(optional),
  max_base64_bytes: PositiveInt.pipe(optional),
  optimize: Schema.Boolean.pipe(optional).annotate({
    description:
      "Fit images to the model, keep the originals, and let the model zoom and recall them, for models that have image limits on record (default: false)",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Media")({
  image: Image.pipe(optional),
}) {}
