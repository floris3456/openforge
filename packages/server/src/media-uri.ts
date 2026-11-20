import type { HttpServerRequest } from "effect/http"

const CAPABILITIES_HEADER = "x-opencode-capabilities"
const MEDIA_URI_CAPABILITY = "experimental-media-uri"

/** Whether the client opted into `media:` refs, which picks which read to call. */
export const wantsMediaRefs = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers[CAPABILITIES_HEADER]?.split(",").some(
    (token) => token.trim().toLowerCase() === MEDIA_URI_CAPABILITY,
  ) ?? false
