import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Attention } from "@opencode/schema/attention"
import { SessionID } from "@opencode/schema/session-id"
import { Desktop } from "../src/notify/desktop"
import { Follow } from "../src/notify/follow"
import { Player } from "../src/notify/player"
import { Relay } from "../src/notify/relay"
import { Speaker } from "../src/notify/speaker"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

// `openforge notify`: the relay's lines, playing the same occurrence once, reconnecting, and never starting a service.

const occurrence = (input: Partial<Attention.Occurrence> = {}): Attention.Occurrence => ({
  kind: "done",
  sessionID: SessionID.make("ses_0000000000000000000000000a"),
  title: "openforge test",
  message: "Chat A is done",
  notify: true,
  sound: { name: "done" },
  focused: false,
  ...input,
})

describe("relay lines", () => {
  test("each line goes as one JSON line and reads back the same", () => {
    const lines: Relay.Encoded[] = [
      { type: "hello", version: Relay.VERSION },
      { type: "status", text: "No openforge service runs here; waiting for one to start." },
      { type: "debug", text: "detail" },
      { type: "following", url: "http://127.0.0.1:48020", version: "0.0.6" },
      { type: "alive" },
      { type: "occurrence", occurrence: occurrence(), test: true },
      {
        type: "occurrence",
        occurrence: occurrence({ sound: { name: "question", file: "/sounds/q.wav" } }),
        sound: { file: "/sounds/q.wav", data: Buffer.from("RIFF").toString("base64") },
      },
      { type: "occurrence", occurrence: occurrence(), sound: { file: "/sounds/q.wav", error: "ENOENT" } },
    ]
    for (const line of lines) {
      const text = Relay.encode(line)
      expect(text.endsWith("\n")).toBe(true)
      expect(text.slice(0, -1)).not.toContain("\n")
      const decoded: unknown = Relay.decode(text.trimEnd())
      expect(decoded).toEqual(line)
    }
  })

  test("what is not a relay line reads as none", () => {
    // What a shell startup file on the other machine prints, a line of a newer release, a broken occurrence.
    for (const text of [
      "Last login: Tue Nov  3 10:00:00 on ttys001",
      "{}",
      '{"type":"unknown"}',
      '{"type":"occurrence","occurrence":{"kind":"done"}}',
      '{"type":"hello"',
    ])
      expect(Relay.decode(text)).toBeUndefined()
  })

  test("the relay's command over ssh and through --via", () => {
    const flags = Relay.flags({ desktop: true, test: "question", verbose: false })
    expect(flags).toEqual(["--desktop", "--test=question"])
    const script = Relay.script(flags)
    expect(Relay.command({ target: "me@mac" }, flags)).toEqual([
      "ssh",
      "-T",
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "--",
      "me@mac",
      `sh -c '${script}'`,
    ])
    // --via runs its arguments as they are, so the script needs no quoting of its own.
    expect(Relay.command({ via: Relay.via("  ocp   run ") }, flags)).toEqual(["ocp", "run", "sh", "-c", script])
    expect(script).not.toContain("'")
  })

  test.skipIf(process.platform === "win32")(
    "the script finds openforge in ~/.local/bin, or says it is not there",
    async () => {
      // Windows has no POSIX sh for the script; the relay runs on the machine the service runs on.
      await using dir = await tmpdir()
      const bin = path.join(dir.path, ".local", "bin")
      await mkdir(bin, { recursive: true })
      await writeFile(path.join(bin, "openforge"), '#!/bin/sh\necho "found $*"\n')
      await chmod(path.join(bin, "openforge"), 0o755)
      const run = async (home: string) => {
        const child = Bun.spawn(["sh", "-c", Relay.script(["--desktop"])], {
          env: { HOME: home, PATH: "/usr/bin:/bin" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { stdout, stderr, code }
      }
      expect(await run(dir.path)).toEqual({ stdout: "found notify --relay --desktop\n", stderr: "", code: 0 })
      const missing = await run(path.join(dir.path, "nobody"))
      expect(missing.stderr.trim()).toBe(Relay.NOT_FOUND)
      expect(missing.code).toBe(127)
      expect(Relay.ended("mac", true, missing.code, missing.stderr.trim())).toBe(
        "openforge is not installed on mac (looked on PATH and in ~/.local/bin)",
      )
      expect(Relay.ended("mac", true, 255, "ssh: connect to host mac port 22: Connection refused")).toBe(
        "ssh mac failed: ssh: connect to host mac port 22: Connection refused",
      )
    },
  )

  test("a custom sound file is sent with the first occurrence that names it, in order", async () => {
    const written: Relay.Encoded[] = []
    const reads: string[] = []
    const slow = Promise.withResolvers<void>()
    const send = Relay.createSender(
      (line) => written.push(line),
      async (file) => {
        reads.push(file)
        if (file === "/missing.wav") throw new Error("ENOENT: no such file")
        if (file === "/big.wav") return new Uint8Array(4 * 1024 * 1024 + 1)
        await slow.promise
        return new TextEncoder().encode("RIFF")
      },
    )
    const custom = occurrence({ sound: { name: "done", file: "/a.wav" } })
    // Two TUIs on the same chat: the second copy comes after the first and does not carry the file again.
    const first = send({ occurrence: custom })
    const second = send({ occurrence: { ...custom, focused: true } })
    const plain = send({ occurrence: occurrence({ message: "other" }) })
    slow.resolve()
    await Promise.all([first, second, plain])
    expect(written).toEqual([
      {
        type: "occurrence",
        occurrence: custom,
        sound: { file: "/a.wav", data: Buffer.from("RIFF").toString("base64") },
      },
      { type: "occurrence", occurrence: { ...custom, focused: true } },
      { type: "occurrence", occurrence: occurrence({ message: "other" }) },
    ])
    expect(reads).toEqual(["/a.wav"])

    // A file that can't be read is tried again the next time; one too large is not sent.
    const missing = occurrence({ sound: { name: "error", file: "/missing.wav" } })
    await send({ occurrence: missing })
    await send({ occurrence: missing })
    await send({ occurrence: occurrence({ sound: { name: "error", file: "/big.wav" } }) })
    expect(written.slice(3).map((line) => (line.type === "occurrence" ? line.sound : undefined))).toEqual([
      { file: "/missing.wav", error: "ENOENT: no such file" },
      { file: "/missing.wav", error: "ENOENT: no such file" },
      { file: "/big.wav", error: "it is larger than 4 MB" },
    ])
  })
})

describe("player", () => {
  const setup = (show = true) => {
    const played: string[] = []
    const shown: string[] = []
    const logged: string[] = []
    const timers: (() => void)[] = []
    const player = Player.create({
      play: async (sound) => {
        played.push(sound.name)
        return sound.name
      },
      show: show
        ? async (title, message) => {
            shown.push(`${title}: ${message}`)
          }
        : undefined,
      log: (line) => logged.push(line),
      debug: () => {},
      wait: (ms, then) => {
        expect(ms).toBe(Player.SAME_MS)
        timers.push(then)
      },
    })
    // The end of each 300 ms window.
    const elapse = async () => {
      timers.splice(0).forEach((then) => then())
      await Bun.sleep(0)
    }
    return { player, played, shown, logged, elapse }
  }

  test("the same occurrence within 300 ms plays once and shows once", async () => {
    const it = setup()
    it.player.receive(occurrence())
    it.player.receive(occurrence())
    await Bun.sleep(0)
    expect(it.played).toEqual(["done"])
    // The desktop notification waits for the end of the window.
    expect(it.shown).toEqual([])
    await it.elapse()
    expect(it.shown).toEqual(["openforge test: Chat A is done"])

    // After the window it is a new occurrence.
    it.player.receive(occurrence())
    await it.elapse()
    expect(it.played).toEqual(["done", "done"])
    expect(it.shown).toHaveLength(2)
  })

  test("a copy from a focused TUI suppresses the desktop notification, not the sound", async () => {
    const it = setup()
    it.player.receive(occurrence())
    it.player.receive(occurrence({ focused: true }))
    await it.elapse()
    expect(it.played).toEqual(["done"])
    expect(it.shown).toEqual([])
  })

  test("other chats and other messages are other occurrences", async () => {
    const it = setup()
    it.player.receive(occurrence())
    it.player.receive(occurrence({ sessionID: SessionID.make("ses_0000000000000000000000000b") }))
    it.player.receive(occurrence({ message: "Chat A failed", kind: "error", sound: { name: "error" } }))
    await it.elapse()
    expect(it.played).toEqual(["done", "done", "error"])
    expect(it.shown).toHaveLength(3)
  })

  test("what the TUI shows no notification or sound for gets none", async () => {
    const it = setup()
    it.player.receive(occurrence({ notify: false, sound: undefined }))
    await it.elapse()
    expect(it.played).toEqual([])
    expect(it.shown).toEqual([])
    // A copy that has the sound plays it.
    it.player.receive(occurrence({ notify: false, sound: undefined }))
    it.player.receive(occurrence({ notify: false }))
    await it.elapse()
    expect(it.played).toEqual(["done"])
    expect(it.shown).toEqual([])
  })

  test("without --desktop it only plays; a failing sound is told once", async () => {
    const logged: string[] = []
    const player = Player.create({
      play: () => Promise.reject(new Error("no sound device could be opened")),
      log: (line) => logged.push(line),
      debug: () => {},
      wait: (_ms, then) => then(),
    })
    player.receive(occurrence())
    player.receive(occurrence({ message: "next" }))
    await Bun.sleep(0)
    expect(logged).toEqual(["Sound done did not play: no sound device could be opened"])
  })

  test("a custom file that can't be had plays the built-in sound", async () => {
    const played: string[] = []
    const play = Speaker.player({
      speaker: {
        play: async (key, bytes, volume) => {
          await bytes()
          played.push(`${key} ${volume}`)
        },
        dispose: () => {},
      },
      volume: 0.2,
      builtin: () => path.join(import.meta.dir, "notify.test.ts"),
      custom: () => Promise.reject(new Error("mac did not send it")),
    })
    expect(await play({ name: "question", file: "/sounds/q.wav" })).toBe(
      "question (built-in; /sounds/q.wav did not play: mac did not send it)",
    )
    expect(played).toEqual(["question 0.2"])
  })

  test("the desktop command takes the text as arguments, never as code", () => {
    expect(Desktop.command("linux", "openforge test", "a <b> & c")).toEqual([
      "notify-send",
      "--app-name=openforge",
      "--",
      "openforge test",
      "a &lt;b&gt; &amp; c",
    ])
    expect(Desktop.command("darwin", 'say "hi"', "x")).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      'say "hi"',
      "x",
    ])
  })
})

describe("following", () => {
  test("reconnecting waits 1 s, then twice as long each time, up to 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(Follow.reconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })

  test("with no service it looks once and then only when the registration file changes", async () => {
    await using dir = await tmpdir()
    const registration = path.join(dir.path, "state", "openforge", "service.json")
    const said: string[] = []
    const looked = { count: 0, next: Promise.withResolvers<void>() }
    const stop = new AbortController()
    const done = Follow.local(
      {
        desktop: false,
        discover: async () => {
          looked.count++
          looked.next.resolve()
          return undefined
        },
        registration,
        say: (line) => said.push(line),
        debug: () => {},
        following: () => {},
        occurrence: () => {},
      },
      stop.signal,
    )
    await looked.next.promise
    // Nothing runs, so nothing is asked: a poll would have looked again by now.
    await Bun.sleep(400)
    expect(looked.count).toBe(1)
    looked.next = Promise.withResolvers()
    await writeFile(registration, "{}")
    await looked.next.promise
    expect(looked.count).toBe(2)
    stop.abort()
    await done
    expect(said).toEqual(["No openforge service runs here; waiting for one to start."])
  })

  test("a service that is still starting is asked again on a timer; one that failed is not", async () => {
    await using dir = await tmpdir()
    const registration = path.join(dir.path, "service.json")
    const endpoint = { url: "http://127.0.0.1:1" }
    const said: string[] = []
    const debug: string[] = []
    const answers: ("waiting" | "failed")[] = ["waiting", "failed"]
    const looked = { count: 0, failed: Promise.withResolvers<void>() }
    const stop = new AbortController()
    const done = Follow.local(
      {
        desktop: false,
        discover: async () => {
          looked.count++
          const state = answers.shift()
          if (state === "failed") looked.failed.resolve()
          return state === undefined ? undefined : { endpoint, state }
        },
        registration,
        say: (line) => said.push(line),
        debug: (line) => debug.push(line),
        following: () => {},
        occurrence: () => {},
      },
      stop.signal,
    )
    await looked.failed.promise
    await Bun.sleep(400)
    expect(looked.count).toBe(2)
    stop.abort()
    await done
    expect(debug).toEqual(["The service at http://127.0.0.1:1 is starting; looking again in 250 ms."])
    expect(said).toEqual([
      "No openforge service runs here; waiting for one to start.",
      "The service at http://127.0.0.1:1 failed to start; waiting for one to start.",
    ])
  })

  test.skipIf(process.platform === "win32")(
    "through --via: lost connections are made again with longer waits, the test asked for once",
    async () => {
      // A stand-in openforge on the other end: a shell banner, the relay's lines, then it ends.
      await using dir = await tmpdir()
      const bin = path.join(dir.path, ".local", "bin")
      await mkdir(bin, { recursive: true })
      const lines = [
        { type: "hello", version: Relay.VERSION },
        { type: "following", url: "http://127.0.0.1:48020", version: "9.9.9" },
        {
          type: "occurrence",
          occurrence: occurrence({ sound: { name: "done", file: "/a.wav" } }),
          sound: { file: "/a.wav", data: Buffer.from("RIFF").toString("base64") },
        },
      ].map((line) => `echo '${JSON.stringify(line)}'`)
      await writeFile(
        path.join(bin, "openforge"),
        ["#!/bin/sh", 'echo "$*" >> "$HOME/args.log"', "echo 'Welcome to the container'", ...lines, "exit 3", ""].join(
          "\n",
        ),
      )
      await chmod(path.join(bin, "openforge"), 0o755)
      const said: string[] = []
      const got: string[] = []
      const files: string[] = []
      const delays: number[] = []
      const stop = new AbortController()
      await Follow.remote(
        {
          route: { via: ["env", `HOME=${dir.path}`, "PATH=/usr/bin:/bin"] },
          label: "the container",
          desktop: true,
          verbose: false,
          test: "question",
          soundFile: (file, data) => files.push(`${file} ${data instanceof Error ? data.message : data.byteLength}`),
          sleep: async (ms) => {
            delays.push(ms)
            if (delays.length === 3) stop.abort()
          },
          say: (line) => said.push(line),
          debug: () => {},
          following: (url, version) => got.push(`following ${url} ${version}`),
          occurrence: (item, isTest) => got.push(`${item.kind} ${isTest}`),
        },
        stop.signal,
      )
      expect(delays).toEqual([1_000, 2_000, 4_000])
      expect(said).toEqual([
        "Lost the connection to the container: the relay on the container ended (exit 3). Reconnecting in 1 s.",
        "Lost the connection to the container: the relay on the container ended (exit 3). Reconnecting in 2 s.",
        "Lost the connection to the container: the relay on the container ended (exit 3). Reconnecting in 4 s.",
      ])
      expect(got).toEqual(Array(3).fill(["following http://127.0.0.1:48020 9.9.9", "done false"]).flat())
      expect(files).toEqual(Array(3).fill("/a.wav 4"))
      // The test is asked of the first relay that followed its service only.
      expect((await Bun.file(path.join(dir.path, "args.log")).text()).trim().split("\n")).toEqual([
        "notify --relay --desktop --test=question",
        "notify --relay --desktop",
        "notify --relay --desktop",
      ])
    },
  )

  test.skipIf(process.platform === "win32")(
    "through --via: no openforge there, another release's lines, a relay gone quiet",
    async () => {
      await using dir = await tmpdir()
      const bin = path.join(dir.path, ".local", "bin")
      await mkdir(bin, { recursive: true })
      const run = async (body: string) => {
        await writeFile(path.join(bin, "openforge"), `#!/bin/sh\n${body}\n`)
        await chmod(path.join(bin, "openforge"), 0o755)
        const said: string[] = []
        const stop = new AbortController()
        await Follow.remote(
          {
            route: {
              via: ["env", `HOME=${body === "" ? path.join(dir.path, "nobody") : dir.path}`, "PATH=/usr/bin:/bin"],
            },
            label: "mac",
            desktop: false,
            verbose: false,
            idleMs: 200,
            soundFile: () => {},
            sleep: async () => stop.abort(),
            say: (line) => said.push(line),
            debug: () => {},
            following: () => {},
            occurrence: () => {},
          },
          stop.signal,
        )
        return said
      }
      expect(await run("")).toEqual([
        "Could not reach openforge on mac: openforge is not installed on mac (looked on PATH and in ~/.local/bin). Trying again in 1 s.",
      ])
      expect(await run(`echo '{"type":"hello","version":2}'; exec sleep 30`)).toEqual([
        "Lost the connection to mac: openforge there writes relay lines of version 2, this one reads 1; update both. Reconnecting in 1 s.",
      ])
      // A connection that died without closing: no line, not even "alive", for the idle time.
      expect(await run(`echo '{"type":"hello","version":1}'; exec sleep 30`)).toEqual([
        "Lost the connection to mac: no word from the relay for 0.2 s. Reconnecting in 1 s.",
      ])
    },
  )
})

describe("the command", () => {
  const cli = path.join(import.meta.dir, "../src/index.ts")
  const registrations = async (root: string) =>
    (await readdir(path.join(root, "state", "openforge")).catch(() => [])).filter((name) => name.startsWith("service"))

  test("the relay says it waits for a service, starts none, and ends when its stdin closes", async () => {
    await using dir = await tmpdir()
    const child = Bun.spawn([process.execPath, cli, "notify", "--relay", "--test=error"], {
      env: isolatedEnv(dir.path),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const state = { text: "" }
    while (!state.text.includes('"status"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.text += new TextDecoder().decode(chunk.value)
    }
    child.stdin.end()
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(
      state.text
        .trim()
        .split("\n")
        .map((line) => Relay.decode(line)),
    ).toEqual([
      { type: "hello", version: Relay.VERSION },
      { type: "status", text: "No openforge service runs here; waiting for one to start." },
    ])
    expect(await registrations(dir.path)).toEqual([])
  })

  test("the player says it waits for a service, starts none, and stops on Ctrl+C", async () => {
    await using dir = await tmpdir()
    const child = Bun.spawn([process.execPath, cli, "notify", "--test", "--volume", "0.2"], {
      env: isolatedEnv(dir.path),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const state = { text: "" }
    while (!state.text.includes("waiting for one to start")) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.text += new TextDecoder().decode(chunk.value)
    }
    child.kill("SIGINT")
    await child.exited
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.text += new TextDecoder().decode(chunk.value)
    }
    expect(await new Response(child.stderr).text()).toBe("")
    expect(state.text.split("\n").map((line) => line.slice(13))).toEqual([
      "No openforge service runs here; waiting for one to start.",
      "Stopped.",
      "",
    ])
    expect(await registrations(dir.path)).toEqual([])
  })
})
