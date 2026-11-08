export * as Speaker from "./speaker"

import { Audio, type AudioSound } from "@opentui/core"
import type { Attention } from "@opencode/schema/attention"
import { SoundOutput } from "@opencode/tui/sound-output"
import { errorMessage } from "../util/error"

// How `openforge notify` plays a sound: OpenTUI's audio, as the TUI plays its own, with no external player.

export interface Speaker {
  /** Plays the sound `key`, decoding `bytes` the first time; rejects with why it can't. */
  play(key: string, bytes: () => Promise<Uint8Array>, volume: number): Promise<void>
  dispose(): void
}

/**
 * `available`: whether this machine has anywhere to play a sound. Without one the audio is never opened: on Linux it
 * would print libasound's errors to the terminal.
 */
export function openTui(
  input: { readonly available: () => boolean } = { available: () => SoundOutput.available() },
): Speaker {
  const state = { audio: undefined as Audio | undefined, error: "" }
  const sounds = new Map<string, AudioSound>()
  const audio = () => {
    if (state.audio !== undefined) return state.audio
    const created = Audio.create({ autoStart: false })
    // Audio says why a call returned null or false only through this event.
    created.on("error", (error: Error) => {
      state.error = error.message
    })
    state.audio = created
    return created
  }
  const why = (fallback: string) => (state.error === "" ? fallback : state.error)
  return {
    async play(key, bytes, volume) {
      if (!input.available()) throw new Error("this machine has no sound device (no PulseAudio server or ALSA card)")
      const current = audio()
      const known = sounds.get(key)
      const sound = known ?? current.loadSound(await bytes())
      if (sound === null) throw new Error(`the sound could not be decoded (${why("unknown format")})`)
      sounds.set(key, sound)
      // The device opens with the first sound and stays open; after a failure the next sound tries again.
      if (!current.isStarted() && !current.start()) throw new Error(`no sound device could be opened (${why("none")})`)
      if (current.play(sound, { volume }) === null)
        throw new Error(`the sound could not be played (${why("no voice")})`)
    },
    dispose() {
      state.audio?.dispose()
      state.audio = undefined
      sounds.clear()
    },
  }
}

/**
 * Hands each sound to a command instead (hidden `--sound-command`): it gets the sound's name or file and the volume as
 * arguments and the sound's bytes on stdin. A recording stand-in on a machine without a sound device uses it.
 */
export function command(words: readonly string[]): Speaker {
  return {
    async play(key, bytes, volume) {
      const child = Bun.spawn([...words, key, String(volume)], {
        stdin: await bytes(),
        stdout: "ignore",
        stderr: "pipe",
      })
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw new Error(`${words[0]} exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`)
    },
    dispose() {},
  }
}

/**
 * Plays a sound the TUI named: its built-in sound from this install, or the custom file it set, which the source gets
 * (from the relay, or from disk on this machine). A custom file that can't be had plays the built-in sound instead.
 * Answers what was played.
 */
export function player(input: {
  readonly speaker: Speaker
  readonly volume: number
  readonly builtin: (name: Attention.Kind) => string
  readonly custom: (file: string) => Promise<Uint8Array>
}) {
  const builtin = (name: Attention.Kind) =>
    input.speaker.play(name, () => Bun.file(input.builtin(name)).bytes(), input.volume).then(() => name)
  return async (sound: Attention.Sound) => {
    const file = sound.file
    if (file === undefined) return builtin(sound.name)
    const custom = await input.speaker
      .play(`file:${file}`, () => input.custom(file), input.volume)
      .then(
        () => undefined,
        (error: unknown) => errorMessage(error),
      )
    if (custom === undefined) return file
    return builtin(sound.name).then((name) => `${name} (built-in; ${file} did not play: ${custom})`)
  }
}
