import { EOL } from "node:os"
import { Service } from "@opencode/client/effect/service"
import { Attention } from "@opencode/schema/attention"
import { Product } from "@opencode/schema/product"
import { Effect, FileSystem, Option, Schema } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServiceConfig } from "../../services/service-config"

// `openforge notify [<ssh-target>]`: plays the notification sounds of one service's chats on this machine, and with
// --desktop shows its notifications here. The service is never started: notify waits for one.

export default Runtime.handler(
  Commands.commands.notify,
  Effect.fn("cli.notify")(function* (input) {
    const target = Option.getOrUndefined(input.target)
    const via = Option.getOrUndefined(input.via)
    const test = Option.getOrUndefined(input.test)
    // `--test question` leaves `question` as the ssh target: the event goes after an equals sign.
    if (target !== undefined && (Attention.testKinds as readonly string[]).includes(target))
      return yield* Effect.fail(
        new Error(`"${target}" would be the ssh target; give the test's event after an equals sign: --test=${target}`),
      )
    if (target !== undefined && via !== undefined)
      return yield* Effect.fail(new Error("Give an ssh target or --via, not both"))
    if (input.relay && (target !== undefined || via !== undefined))
      return yield* Effect.fail(new Error("--relay follows this machine's service; it takes no ssh target or --via"))

    const { Follow } = yield* Effect.promise(() => import("../../notify/follow"))
    const { Relay } = yield* Effect.promise(() => import("../../notify/relay"))
    const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem>())
    const registration = (yield* ServiceConfig.options()).file
    // Found through its registration file and asked how it is, never started: following alone is no reason to run one.
    const discover = async () => {
      const info = Option.getOrUndefined(
        decodeRegistration(
          await Bun.file(registration)
            .text()
            .catch(() => ""),
        ),
      )
      if (info === undefined) return undefined
      return run(Service.incumbent({ file: registration, url: info.url }))
    }

    if (input.relay) {
      const write = (line: typeof Relay.Line.Encoded) => process.stdout.write(Relay.encode(line))
      const send = Relay.createSender(write, (file) => Bun.file(file).bytes())
      write({ type: "hello", version: Relay.VERSION })
      return yield* Effect.promise((signal) => {
        // The player went away: ssh, or the --via command, closed this end's stdin.
        const gone = new AbortController()
        void Bun.stdin
          .stream()
          .pipeTo(new WritableStream())
          .catch(() => {})
          .finally(() => gone.abort())
        process.stdout.on("error", () => gone.abort())
        const alive = setInterval(() => write({ type: "alive" }), Relay.ALIVE_MS)
        return Follow.local(
          {
            desktop: input.desktop,
            test,
            discover,
            registration,
            say: (text) => write({ type: "status", text }),
            debug: input.verbose ? (text) => write({ type: "debug", text }) : () => {},
            following: (url, version) => write({ type: "following", url, version }),
            occurrence: (occurrence, isTest) => void send({ occurrence, ...(isTest ? { test: true as const } : {}) }),
          },
          AbortSignal.any([signal, gone.signal]),
        ).finally(() => clearInterval(alive))
      })
    }

    const { Desktop } = yield* Effect.promise(() => import("../../notify/desktop"))
    const { Player } = yield* Effect.promise(() => import("../../notify/player"))
    const { Speaker } = yield* Effect.promise(() => import("../../notify/speaker"))
    // The TUI's own built-in sounds, from this install.
    const { BUILTIN_SOUNDS } = yield* Effect.promise(() => import("@opencode/tui/attention"))
    const log = (line: string) => process.stdout.write(`${clock()} ${line}${EOL}`)
    const debug = input.verbose ? log : () => {}
    const desktop = input.desktop ? Desktop.notifier() : undefined
    if (desktop !== undefined && "error" in desktop) log(`Desktop notifications are off: ${desktop.error}.`)
    const show = desktop !== undefined && "show" in desktop ? desktop.show : undefined
    const speaker = Option.match(input.soundCommand, {
      onNone: () => Speaker.openTui(),
      onSome: (command) => Speaker.command(Relay.via(command)),
    })
    const route = target !== undefined ? { target } : via !== undefined ? { via: Relay.via(via) } : undefined
    const label = target ?? via ?? "this machine"
    // Custom sound files the relay sent along; on this machine they are read from disk.
    const files = new Map<string, Uint8Array | Error>()
    const player = Player.create({
      play: Speaker.player({
        speaker,
        volume: input.volume,
        builtin: (name) => BUILTIN_SOUNDS[name],
        custom:
          route === undefined
            ? (file) => Bun.file(file).bytes()
            : async (file) => {
                const sent = files.get(file)
                if (sent instanceof Error) throw sent
                if (sent === undefined) throw new Error(`${label} did not send it`)
                return sent
              },
      }),
      show,
      log,
      debug,
    })
    const events = {
      say: log,
      debug,
      following: (url: string, version: string) =>
        log(
          `Following the ${Product.name} ${version} service at ${url}${route === undefined ? "" : ` on ${label}`}: ${show === undefined ? "its sounds play" : "its sounds play and its notifications show"} here.`,
        ),
      occurrence: (occurrence: Attention.Occurrence, isTest: boolean) => player.receive(occurrence, isTest),
    }
    if (route !== undefined) log(`Connecting to ${label}...`)
    yield* Effect.promise((signal) => {
      // Ctrl+C: release the sound device at once.
      signal.addEventListener(
        "abort",
        () => {
          speaker.dispose()
          log("Stopped.")
        },
        { once: true },
      )
      const desktopOn = show !== undefined
      if (route === undefined)
        return Follow.local({ ...events, desktop: desktopOn, test, discover, registration }, signal)
      return Follow.remote(
        {
          ...events,
          route,
          label,
          desktop: desktopOn,
          verbose: input.verbose,
          test,
          soundFile: (file, data) => files.set(file, data),
        },
        signal,
      )
    }).pipe(Effect.ensuring(Effect.sync(() => speaker.dispose())))
  }),
)

const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Service.Info))

function clock() {
  const now = new Date()
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, "0")}`
}
