import { describe, expect, test } from "bun:test"
import { SoundOutput } from "../src/sound-output"

// openforge: the audio opens only where a sound can play. Found 2026-11-08 in the owner's devbox-theorysnap container
// (libasound and libpulse installed, no sound card, no PulseAudio server): a sound printed 35 lines of
// `ALSA lib … cannot find card '0'` over the TUI.

/** A Linux machine with nothing but what `files` and `env` name. */
const linux = (input: { env?: Record<string, string>; uid?: number; files?: Record<string, string> } = {}) => {
  const files = input.files ?? {}
  return {
    platform: "linux" as const,
    env: input.env ?? {},
    uid: input.uid,
    exists: (path: string) => path in files,
    read: (path: string) => files[path],
    list: (path: string) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1)),
  }
}

describe("SoundOutput.available", () => {
  test("a container without a sound server or card: no", () => {
    expect(SoundOutput.available(linux({ uid: 0 }))).toBe(false)
    // /proc/asound without a card, as a kernel without sound devices shows it.
    expect(SoundOutput.available(linux({ files: { "/proc/asound/cards": "--- no soundcards ---\n" } }))).toBe(false)
    // A /dev/snd with only the sequencer and timer: nothing to play on.
    expect(SoundOutput.available(linux({ files: { "/dev/snd/seq": "", "/dev/snd/timer": "" } }))).toBe(false)
    expect(SoundOutput.available(linux({ env: { PULSE_SERVER: "" } }))).toBe(false)
  })

  test("a PulseAudio server, PipeWire's included: yes", () => {
    expect(SoundOutput.available(linux({ env: { PULSE_SERVER: "tcp:host.docker.internal:4713" } }))).toBe(true)
    expect(
      SoundOutput.available(
        linux({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, files: { "/run/user/1000/pulse/native": "" } }),
      ),
    ).toBe(true)
    // XDG_RUNTIME_DIR unset, as in a shell docker exec opened: the user's own runtime folder.
    expect(SoundOutput.available(linux({ uid: 1000, files: { "/run/user/1000/pulse/native": "" } }))).toBe(true)
    // A system-wide server.
    expect(SoundOutput.available(linux({ files: { "/run/pulse/native": "" } }))).toBe(true)
  })

  test("an ALSA sound card: yes", () => {
    const cards =
      " 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n                      HDA Intel PCH at 0xf7f10000 irq 32\n"
    expect(SoundOutput.available(linux({ files: { "/proc/asound/cards": cards } }))).toBe(true)
    expect(SoundOutput.available(linux({ files: { "/dev/snd/pcmC0D0p": "", "/dev/snd/controlC0": "" } }))).toBe(true)
  })

  test("macOS and Windows: always yes, as before", () => {
    for (const platform of ["darwin", "win32"] as const)
      expect(SoundOutput.available({ ...linux({ uid: 501 }), platform })).toBe(true)
  })

  test("this machine's own probe answers without throwing", () => {
    expect(typeof SoundOutput.available()).toBe("boolean")
  })
})
