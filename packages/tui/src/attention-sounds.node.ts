import { createRequire } from "node:module"
import path from "node:path"
import { Attention } from "@opencode/schema/attention"

const require = createRequire(import.meta.url)
const resolve = (name: string) => {
  const key = `@opencode/ui/audio/${name}`
  return process.env.OPENCODE_NODE_ASSETS_DIR
    ? path.join(process.env.OPENCODE_NODE_ASSETS_DIR, key)
    : require.resolve(key)
}

export const soundFiles = Object.fromEntries(Attention.sounds.map((id) => [id, resolve(`${id}.mp3`)])) as Record<
  Attention.SoundID,
  string
>
