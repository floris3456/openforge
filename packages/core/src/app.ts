export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

/**
 * The upstream opencode release openforge is built on: the version in this package's `package.json`, which an upstream
 * merge brings along. Providers read the user agent's version, and OpenCode Zen gives its free tier only to OpenCode
 * 1.18.0 or newer, so the user agent carries this rather than openforge's own 0.0.x, with openforge as the client.
 */
export const UPSTREAM_VERSION = "2.2.5"

export function useragent(app: Info) {
  return `opencode/${app.channel}/${UPSTREAM_VERSION}/openforge`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

export const node = configured()
