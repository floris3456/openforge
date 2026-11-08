#!/usr/bin/env bun

// Builds an openforge release on this machine, and uploads one to GitHub Releases with --publish.
//
// A build writes the release assets into the release folder: release.json, one archive per target (holding only
// the binary), SHA256SUMS and install.sh, as packages/cli/src/upgrade/release.ts reads them, plus build-info.json and
// inputs.json (the repository's files the binaries are built from, and the Bun that built them), which are not
// uploaded. --publish uploads exactly those assets, so the bytes that were tested are the bytes that are released; it
// never builds. The packages are imported by path: the workspace root does not depend on them.

import { $ } from "bun"
import { closeSync, openSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Release } from "../../packages/cli/src/upgrade/release"
import { Product } from "../../packages/schema/src/product"
import { repositoryInputs } from "./inputs"

const targets = Release.platforms
type Target = Release.Platform
const published = ["release.json", ...targets.map(Release.archive), "SHA256SUMS", "install.sh"]
// How long the built binary gets to print its version.
const versionTimeout = 30_000

const usage = `Usage: bun script/openforge/release.ts --version <x.y.z> [--out <dir>]
       bun script/openforge/release.ts --version <x.y.z> [--out <dir>] --publish [--notes-file <file>] [--dry-run]

Without --publish, builds ${targets.join(" and ")} with packages/cli/script/build.ts (channel latest) and
writes the release assets to <dir>, by default ~/OpenForge/releases/<x.y.z>.

--publish   uploads the assets already in <dir> as release v<x.y.z> of ${Product.repository}, marked Latest
--dry-run   checks the assets and prints the gh command --publish would run, without running it`

const root = path.resolve(import.meta.dir, "../..")
const cli = path.join(root, "packages", "cli")
const installer = path.join(import.meta.dir, "install.sh")

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string" },
    out: { type: "string" },
    publish: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "notes-file": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const version = values.version
if (values.help || version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  if (values.help) console.log(usage)
  if (!values.help) console.error(usage)
  process.exit(values.help ? 0 : 1)
}
const out = path.resolve(values.out ?? path.join(os.homedir(), "OpenForge", "releases", version))

if (values.publish || values["dry-run"]) await publish(version)
else await build(version)

async function build(version: string) {
  const commit = (await $`git rev-parse HEAD`.cwd(root).text()).trim()
  const dirty = (await $`git status --porcelain`.cwd(root).text()).trim() !== ""
  if (dirty) console.warn("warning: the worktree has uncommitted changes; --publish will refuse this build")
  await fs.mkdir(out, { recursive: true })

  const builds: Awaited<ReturnType<typeof buildTarget>>[] = []
  // One at a time: each build runs the web UI build and bundles the whole CLI. Only the first installs the native
  // packages of every platform.
  for (const target of targets) builds.push(await buildTarget(version, target, builds.length === 0))

  await fs.copyFile(installer, path.join(out, "install.sh"))
  const files = repositoryInputs(
    builds.flatMap((item) => item.inputs),
    cli,
    root,
  )
  await Bun.write(path.join(out, "inputs.json"), JSON.stringify({ bun: Bun.version, files }, null, 2) + "\n")

  const assets = Object.fromEntries(
    await Promise.all(
      builds.map(async (item) => [
        item.target,
        { name: path.basename(item.archive), sha256: await sha256(item.archive) },
      ]),
    ),
  )
  const manifest = { version, assets } satisfies Release.Manifest
  await Bun.write(path.join(out, "release.json"), JSON.stringify(manifest, null, 2) + "\n")
  await Bun.write(path.join(out, "SHA256SUMS"), await checksums(await present(published)))
  const info = { version, commit, dirty, builtAt: new Date().toISOString() } satisfies BuildInfo
  await Bun.write(path.join(out, "build-info.json"), JSON.stringify(info, null, 2) + "\n")

  console.log(`\n${Product.name} ${version} (${commit.slice(0, 10)}${dirty ? ", uncommitted changes" : ""}) → ${out}`)
  for (const item of builds)
    console.log(
      `  ${item.target.padEnd(13)} built in ${item.seconds.toFixed(1).padStart(6)}s  ${path.basename(item.archive)}  ${((await fs.stat(item.archive)).size / 1e6).toFixed(1)} MB`,
    )
}

async function buildTarget(version: string, target: Target, install: boolean) {
  const outdir = path.join(cli, "dist", "release", target)
  const log = `${outdir}.log`
  await fs.mkdir(path.dirname(outdir), { recursive: true })
  console.log(`building ${target}, log in ${log}`)
  const started = performance.now()
  const descriptor = openSync(log, "w")
  const child = Bun.spawn(
    [process.execPath, "run", "script/build.ts", `--outdir=${outdir}`, ...(install ? [] : ["--skip-install"])],
    {
      cwd: cli,
      env: { ...process.env, OPENCODE_TARGET: target, OPENCODE_VERSION: version, OPENCODE_CHANNEL: "latest" },
      stdin: "ignore",
      stdout: descriptor,
      stderr: descriptor,
    },
  )
  const code = await child.exited
  closeSync(descriptor)
  const seconds = (performance.now() - started) / 1000
  if (code !== 0) {
    console.error((await Bun.file(log).text()).split("\n").slice(-40).join("\n"))
    throw new Error(`Building ${target} failed with exit code ${code} after ${seconds.toFixed(1)}s; full log in ${log}`)
  }
  console.log(`built ${target} in ${seconds.toFixed(1)}s`)

  const binary = path.join(outdir, `cli-${target}`, "bin", Product.binary)
  if (target === `${process.platform}-${process.arch}`) await checkVersion(binary, version)
  const inputs: string[] = await Bun.file(path.join(outdir, `cli-${target}.inputs.json`)).json()
  return { target, seconds, inputs, archive: await pack(binary, target) }
}

// The built binary must report the release's version ("openforge v1.2.3"). It runs in a throwaway home, since starting
// creates its folders.
async function checkVersion(binary: string, version: string) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openforge-release-check-")))
  const result = Bun.spawnSync([binary, "--version"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: versionTimeout,
  })
  await fs.rm(home, { recursive: true, force: true })
  const printed = result.stdout.toString().trim()
  if (printed !== `${Product.binary} v${version}`)
    throw new Error(
      `${binary} --version printed "${printed}" instead of "${Product.binary} v${version}": ${result.stderr.toString()}`,
    )
}

// Each archive holds the binary alone, at its top level.
async function pack(binary: string, target: Target) {
  const archive = path.join(out, Release.archive(target))
  await $`tar --format=ustar --owner=0 --group=0 --numeric-owner -czf ${archive} -C ${path.dirname(binary)} ${Product.binary}`
  const entries = (await $`tar -tzf ${archive}`.text()).trim().split("\n")
  if (entries.length !== 1 || entries[0] !== Product.binary)
    throw new Error(`${archive} must hold only ${Product.binary}, found: ${entries.join(", ")}`)
  return archive
}

async function publish(version: string) {
  const files = await present(published)
  const info = await buildInfo()
  const problems = [
    ...published.filter((name) => !files.includes(name)).map((name) => `missing ${path.join(out, name)}`),
    ...(await verify(version, files)),
    ...(info?.version === version ? [] : [`no build of ${version} recorded in ${path.join(out, "build-info.json")}`]),
    ...(info?.dirty === false ? [] : ["the assets were not built from a clean commit"]),
  ]
  const notes = values["notes-file"]
  // GitHub creates the tag at the commit the assets were built from, so that commit must be pushed first.
  const command = [
    "gh",
    "release",
    "create",
    `v${version}`,
    "--repo",
    Product.repository,
    "--latest",
    ...(info ? ["--target", info.commit] : []),
    ...(notes ? ["--notes-file", path.resolve(notes)] : ["--notes", ""]),
    ...published.map((name) => path.join(out, name)),
  ]

  problems.forEach((problem) => console.error(`${values["dry-run"] ? "warning" : "error"}: ${problem}`))
  if (values["dry-run"]) {
    console.log(command.map(quote).join(" "))
    return
  }
  if (problems.length > 0) process.exit(1)
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(await child.exited)
}

// SHA256SUMS must list every other asset with its checksum, and release.json must describe this version's archives.
async function verify(version: string, files: string[]) {
  const sums = files.includes("SHA256SUMS")
    ? Release.sums(await Bun.file(path.join(out, "SHA256SUMS")).text())
    : new Map<string, string>()
  const listed = await Promise.all(
    files
      .filter((name) => name !== "SHA256SUMS")
      .map(async (name) => {
        const hash = sums.get(name)
        if (hash === undefined) return [`SHA256SUMS does not list ${name}`]
        if (hash !== (await sha256(path.join(out, name)))) return [`SHA256SUMS does not match ${name}`]
        return []
      }),
  )
  if (!files.includes("release.json")) return listed.flat()
  const release = Release.decodeManifest(await Bun.file(path.join(out, "release.json")).text())
  if (!release) return [...listed.flat(), "release.json is not a valid release description"]
  const described = await Promise.all(
    targets.map(async (target) => {
      const name = Release.archive(target)
      const asset = release.assets[target]
      if (!files.includes(name)) return []
      if (asset?.name === name && asset.sha256 === (await sha256(path.join(out, name)))) return []
      return [`release.json does not describe ${name}`]
    }),
  )
  return [
    ...listed.flat(),
    ...described.flat(),
    ...(release.version === version ? [] : [`release.json is for ${release.version}, not ${version}`]),
  ]
}

// What a build records about itself in build-info.json.
type BuildInfo = {
  readonly version: string
  readonly commit: string
  readonly dirty: boolean
  readonly builtAt: string
}

// The build recorded in the release folder; undefined without one.
async function buildInfo() {
  const file = Bun.file(path.join(out, "build-info.json"))
  if (!(await file.exists())) return
  const value: unknown = await file.json().catch(() => undefined)
  if (!isBuildInfo(value)) throw new Error(`${file.name} is not a build record; build ${version} again`)
  return value
}

function isBuildInfo(value: unknown): value is BuildInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "commit" in value &&
    typeof value.commit === "string" &&
    "dirty" in value &&
    typeof value.dirty === "boolean" &&
    "builtAt" in value &&
    typeof value.builtAt === "string"
  )
}

async function present(names: string[]) {
  const found = await Promise.all(
    names.map(async (name) => ((await Bun.file(path.join(out, name)).exists()) ? [name] : [])),
  )
  return found.flat()
}

// sha256sum's format, sorted by name; SHA256SUMS does not list itself.
async function checksums(files: string[]) {
  const lines = await Promise.all(
    files
      .filter((name) => name !== "SHA256SUMS")
      .toSorted()
      .map(async (name) => `${await sha256(path.join(out, name))}  ${name}`),
  )
  return lines.join("\n") + "\n"
}

async function sha256(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

function quote(argument: string) {
  if (/^[\w@%+=:,./-]+$/.test(argument)) return argument
  return `'${argument.replaceAll("'", `'\\''`)}'`
}
