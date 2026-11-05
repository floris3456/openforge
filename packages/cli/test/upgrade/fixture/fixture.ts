import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Database } from "bun:sqlite"
import { Duration, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ReleaseLayout } from "../../../src/upgrade/layout"
import type { Release } from "../../../src/upgrade/release"
import type { ReleaseSwitch } from "../../../src/upgrade/switch"

export type Serve = "ok" | "crash" | "wrong-version" | "unreadable" | "runner-lost"

const program = path.join(import.meta.dir, "fake-openforge.ts")

/** Writes a small `openforge` that reports `version` and runs a fake service (see fake-openforge.ts). */
export async function fakeBinary(
  file: string,
  version: string,
  options: { serve?: Serve; print?: string; runs?: string } = {},
) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await fs.writeFile(
    file,
    [
      "#!/bin/sh",
      // Where it ran from, and with what: `<path> --version`.
      ...(options.runs === undefined ? [] : [`echo "$0 $*" >> ${quote(options.runs)}`]),
      `export FAKE_VERSION=${quote(version)}`,
      `export FAKE_SERVE=${quote(options.serve ?? "ok")}`,
      ...(options.print === undefined ? [] : [`export FAKE_PRINT=${quote(options.print)}`]),
      `exec ${quote(process.execPath)} ${quote(program)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
}

/** A temporary root holding an isolated install: `data`, `state`, `config` and friends. Removed at scope end. */
export const root = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "openforge-upgrade-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
)

export function paths(directory: string) {
  return {
    home: directory,
    data: path.join(directory, "data"),
    config: path.join(directory, "config"),
    state: path.join(directory, "state"),
    cache: path.join(directory, "cache"),
    tmp: path.join(directory, "tmp"),
    bin: path.join(directory, "cache", "bin"),
    log: path.join(directory, "data", "log"),
    repos: path.join(directory, "data", "repos"),
  }
}

/** Services the upgrade code needs, with Global pointed at `directory`. */
export function layer(directory: string) {
  return LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, EffectFlock.node]), {
    replacements: [Global.node.replace(Global.layerWith(paths(directory)))],
  }).pipe(Layer.provideMerge(NodeServices.layer))
}

/** The switch target for an install under `directory`; its services stop at scope end. */
export const target = Effect.fnUntraced(function* (directory: string) {
  const dirs = paths(directory)
  const file = path.join(dirs.state, "service.json")
  const database = path.join(dirs.data, "opencode.db")
  yield* Effect.promise(() => fs.mkdir(dirs.state, { recursive: true }))
  yield* Effect.addFinalizer(() => Service.stop({ file }).pipe(Effect.ignore))
  return {
    layout: ReleaseLayout.at(dirs.data),
    database,
    service: {
      file,
      env: { FAKE_REGISTRATION: file, FAKE_DATABASE: database, FAKE_LOG: history(directory) },
      pty: "handoff" as const,
    },
    log: path.join(dirs.log, "upgrade.log"),
    timeout: Duration.seconds(4),
  } satisfies ReleaseSwitch.Target
})

/** Where the fake services under `directory` write what happened to them (see fake-openforge.ts). */
export function history(directory: string) {
  return path.join(paths(directory).state, "fake.log")
}

/** What happened to the fake services under `directory`, one line each: `0.1.0 started`, `0.1.0 paused`, … */
export async function happened(directory: string) {
  const text = await fs.readFile(history(directory), "utf8").catch(() => "")
  return text.split("\n").filter(Boolean)
}

/** Asks the fake service at `url` something only tests ask: `/fake/work`, `/fake/finish`, `/fake/reads`, … */
export async function fake(url: string, route: string, body?: unknown) {
  const response = await fetch(new URL(route, url), {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.text()
}

/** Puts a fake release straight into the layout, as an install would leave it. */
export async function keep(layout: ReleaseLayout.Layout, version: string, options: { serve?: Serve } = {}) {
  await fakeBinary(ReleaseLayout.binary(layout, version), version, options)
}

export function migrations(file: string) {
  using db = new Database(file, { readonly: true })
  return db
    .query<{ id: string }, []>("SELECT id FROM migration ORDER BY id")
    .all()
    .map((row) => row.id)
}

export function writeMigrations(file: string, ids: ReadonlyArray<string>) {
  using db = new Database(file)
  db.run("CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  ids.forEach((id) => db.run("INSERT OR IGNORE INTO migration (id, time_completed) VALUES (?, ?)", [id, Date.now()]))
}

/** Builds a release's assets the way the release script publishes them. */
export async function publish(
  directory: string,
  version: string,
  options: {
    readonly serve?: Serve
    readonly print?: string
    readonly runs?: string
    readonly extra?: boolean
    readonly sums?: (sha256: string) => string
    readonly manifestSha?: (sha256: string) => string
  } = {},
) {
  const staging = path.join(directory, `stage-${version}`)
  await fakeBinary(path.join(staging, "openforge"), version, options)
  if (options.extra) await fs.writeFile(path.join(staging, "README"), "extra")
  const archive = path.join(directory, `openforge-linux-x64-${version}.tar.gz`)
  const tar = Bun.spawnSync([
    "tar",
    "-czf",
    archive,
    "-C",
    staging,
    ...(options.extra ? ["openforge", "README"] : ["openforge"]),
  ])
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const assets = {
    "linux-x64": { name: "openforge-linux-x64.tar.gz", sha256: options.manifestSha?.(sha256) ?? sha256 },
    "darwin-arm64": { name: "openforge-darwin-arm64.tar.gz", sha256: options.manifestSha?.(sha256) ?? sha256 },
  } satisfies Record<Release.Platform, { name: string; sha256: string }>
  return {
    "release.json": JSON.stringify({ version, assets }),
    "openforge-linux-x64.tar.gz": bytes,
    "openforge-darwin-arm64.tar.gz": bytes,
    SHA256SUMS: [
      `${options.sums?.(sha256) ?? sha256}  openforge-linux-x64.tar.gz`,
      `${options.sums?.(sha256) ?? sha256}  openforge-darwin-arm64.tar.gz`,
      "",
    ].join("\n"),
  } satisfies Record<string, string | Uint8Array>
}

/** A local stand-in for GitHub Releases: `<url>/download/v<version>/<asset>` and `<url>/latest/download/<asset>`. */
export const releaseServer = Effect.fnUntraced(function* (
  releases: Record<string, Record<string, string | Uint8Array>>,
  latest?: string,
) {
  const requests: string[] = []
  const state = { latest }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const pathname = new URL(request.url).pathname
          requests.push(pathname)
          const match =
            pathname.match(/^\/releases\/download\/v([^/]+)\/([^/]+)$/) ??
            (state.latest ? pathname.match(/^\/releases\/latest\/download\/([^/]+)$/) : null)
          const version = match?.length === 3 ? match[1] : state.latest
          const name = match?.at(-1)
          const body = version && name ? releases[version]?.[name] : undefined
          if (body === undefined) return new Response("not found", { status: 404 })
          return new Response(typeof body === "string" ? body : new Blob([new Uint8Array(body)]))
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  return {
    url: `http://127.0.0.1:${server.port}/releases`,
    requests,
    /** Marks another release as GitHub's Latest. */
    latest: (version: string) => {
      state.latest = version
    },
  }
})
