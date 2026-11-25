import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerEnv } from "@opencode/core/pacer/env"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { withEnv } from "../fixture/env"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// What openforge hands CLIProxyPacer of a chat's .env files (workspace spec `docs/specs/env-redaction.md`, sections 2
// and 3): which files, which values, the set and its digest, and the set kept current.

const it = testEffect(Layer.empty)

/** PacerEnv with no CPP set up: its sets need none. */
const start = Effect.gen(function* () {
  const endpoints = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined)
  const catalogs = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(undefined)
  const endpointLayer = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({
      get: () => SubscriptionRef.get(endpoints),
      changes: () => SubscriptionRef.changes(endpoints),
    }),
  )
  const context = yield* Layer.build(
    Layer.fresh(PacerEnv.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer)),
          endpointLayer,
          Layer.succeed(
            PacerModels.Service,
            PacerModels.Service.of({
              get: () => SubscriptionRef.get(catalogs),
              changes: () => SubscriptionRef.changes(catalogs),
              refresh: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  )
  return Context.get(context, PacerEnv.Service)
})

/** Writes `files` (path → text) under `root`, making their folders. */
const write = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(files).map(async ([name, text]) => {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
        await fs.writeFile(path.join(root, name), text)
      }),
    ),
  )

describe("PacerEnv.valueFile", () => {
  it.effect("takes .env and .env.<anything>, but not an example, a sample or a template", () =>
    Effect.sync(() => {
      for (const name of [".env", ".env.local", ".env.production", ".env.development.local", ".env.test"])
        expect([name, PacerEnv.valueFile(name)]).toEqual([name, true])
      for (const name of [
        ".env.example",
        ".env.local.sample",
        ".env.template",
        ".env.production.example",
        ".envrc",
        "env",
        "app.env",
        ".env.",
        ".environment",
      ])
        expect([name, PacerEnv.valueFile(name)]).toEqual([name, false])
    }),
  )
})

describe("PacerEnv.values", () => {
  it.effect("takes each assignment's value as a dotenv reader does, plain or after export", () =>
    Effect.sync(() => {
      expect(
        PacerEnv.values(
          [
            "BUILD_REF=0123456789abcdef0123456789abcdef01234567",
            "export EXPORTED=exported-0123456789",
            "  SPACED = spaced-value-0123",
            "YAML: yaml-style-0123456789",
            "",
            "# COMMENTED=commented-0123456789",
            "   # INDENTED_COMMENT=indented-0123456789",
            "EMPTY=",
            "not an assignment at all, but long words like configuration",
          ].join("\n"),
        ),
      ).toEqual([
        "0123456789abcdef0123456789abcdef01234567",
        "exported-0123456789",
        "spaced-value-0123",
        "yaml-style-0123456789",
      ])
    }),
  )

  it.effect("unquotes quoted values, and takes a quoted value over several lines whole", () =>
    Effect.sync(() => {
      expect(
        PacerEnv.values(
          [
            "SINGLE='single-0123456789'",
            'DOUBLE="double-0123456789"',
            "BACKTICK=`backtick-0123456789`",
            'HASHED="quoted#hash-0123456" # a comment',
            'PEM="-----BEGIN PRIVATE KEY-----',
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
            "abcdefghijklmnopqrstuvwxyz012345",
            '-----END PRIVATE KEY-----"',
            'ESCAPED="-----BEGIN X-----\\nline-one-0123456789\\nline-two-0123456789\\n-----END X-----"',
            "LITERAL='kept\\nas-written-0123'",
            'OPEN="unclosed-0123456789',
          ].join("\n"),
        ),
      ).toEqual([
        "single-0123456789",
        "double-0123456789",
        "backtick-0123456789",
        "quoted#hash-0123456",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "abcdefghijklmnopqrstuvwxyz012345",
        "line-one-0123456789",
        "line-two-0123456789",
        // A single-quoted value is literal: its backslash and n stay.
        "kept\\nas-written-0123",
        "unclosed-0123456789",
      ])
    }),
  )

  it.effect("ends a plain value at a comment, also as readers that end it at any # do", () =>
    Effect.sync(() => {
      expect(
        PacerEnv.values(
          [
            "COMMENTED=plain-0123456789 # with longwordsinside",
            "INSIDE=hash#inside0123456",
            "BOTH=0123456789abcdef#tail",
          ].join("\n"),
        ),
      ).toEqual(["plain-0123456789", "hash#inside0123456", "0123456789abcdef", "0123456789abcdef#tail"])
    }),
  )

  it.effect("cuts a value as layer 1 does: each token, each line, 12 bytes or more", () =>
    Effect.sync(() => {
      expect(
        PacerEnv.values(
          [
            "TWELVE=abcdefghijkl",
            "ELEVEN=abcdefghijk",
            // 'é' is two bytes: six of them are twelve, five and a digit eleven.
            "WIDE=éééééé",
            "NARROW=ééééé1",
            'AUTH="Bearer tok-0123456789abcdef"',
            'COOKIE="sid=cookie-0123456789; theme=dark"',
            'WORDS="a sentence of short words only"',
            "LIST=first-0123456789,second-0123456789",
            "CRLF=crlf-value-0123456\r",
            "NEXT=after-crlf-0123456",
          ].join("\n"),
        ),
      ).toEqual([
        "abcdefghijkl",
        "éééééé",
        "tok-0123456789abcdef",
        "cookie-0123456789",
        // Commas cut only a value that has spaces or semicolons, as layer 1 cuts one.
        "first-0123456789,second-0123456789",
        "crlf-value-0123456",
        "after-crlf-0123456",
      ])
    }),
  )

  it.effect("leaves out paths, plain URLs and password hashes, and takes a URL's password", () =>
    Effect.sync(() => {
      expect(
        PacerEnv.values(
          [
            "DIR=/var/lib/application/data",
            "REL=./relative/path/to/data",
            "HOME_DIR=~/some/long/folder",
            "SITE=https://example.com/a/long/path",
            "DATABASE_URL=postgres://user:db-password-0123@db.internal:5432/app",
            "SHORT_PASSWORD=postgres://user:short@db.internal:5432/app",
            "HASH=$2b$12$abcdefghijklmnopqrstuv",
          ].join("\n"),
        ),
      ).toEqual(["db-password-0123"])
    }),
  )
})

describe("PacerEnv's set and digest", () => {
  it.effect("sorts the values by their UTF-8 bytes, once each", () =>
    Effect.sync(() => {
      // U+FF5E is EF BD 9E in UTF-8 and U+1F600 is F0 9F 98 80, the other way round in UTF-16 (FF5E, D83D DE00).
      const wide = "\u{FF5E}-0123456789"
      const emoji = "\u{1F600}-0123456789"
      expect(PacerEnv.sorted([emoji, "b-0123456789ab", wide, "a-0123456789ab", "b-0123456789ab"])).toEqual([
        "a-0123456789ab",
        "b-0123456789ab",
        wide,
        emoji,
      ])
    }),
  )

  it.effect("is an HMAC-SHA-256 keyed with the client key over the values joined by NUL, in lower-case hex", () =>
    Effect.sync(() => {
      // printf '0123456789abcdef\0abcdefghijkl' | openssl dgst -sha256 -hmac client-key-test
      expect(PacerEnv.digest("client-key-test", ["0123456789abcdef", "abcdefghijkl"])).toBe(
        "3a231e74ae2c1ac8466ccc690db19c45e4017601230bc9cf3a6956ec13870871",
      )
      expect(PacerEnv.digest("client-key-test", ["only-one-value-x"])).toBe(
        "f5d20953e6828d7a4e44e79e9a889f6e6604987f194cecf38d3cd37358055bb5",
      )
    }),
  )
})

describe("PacerEnv's sets", () => {
  it.live("reads every .env file of a repository, nested repositories included, but not node_modules or .git", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const outside = (yield* tmpdirScoped()).path
      yield* write(outside, { ".env": "OUTSIDE=outside-0123456789\n", "dir/.env": "LINKED=linked-dir-0123456\n" })
      yield* write(root, {
        ".env": "ROOT=root-value-0123456\n",
        ".env.local": "LOCAL=local-value-012345\n",
        ".env.production": "PRODUCTION=production-0123456\n",
        ".env.example": "EXAMPLE=example-0123456789\n",
        ".env.local.sample": "SAMPLE=sample-0123456789\n",
        ".env.template": "TEMPLATE=template-0123456789\n",
        "nested/.git/HEAD": "ref: refs/heads/main\n",
        "nested/.env": "NESTED=nested-value-01234\n",
        "deep/er/still/.env.development": "DEEP=deep-value-0123456\n",
        "node_modules/package/.env": "MODULE=module-value-01234\n",
        "nested/node_modules/package/.env": "NESTED_MODULE=nested-module-0123\n",
        ".git/.env": "GIT=git-folder-0123456\n",
        "README.md": "ROOT_DOC=not-a-dotenv-file-0123\n",
      })
      yield* Effect.promise(async () => {
        await fs.symlink(path.join(outside, ".env"), path.join(root, ".env.linked"))
        await fs.symlink(path.join(outside, "dir"), path.join(root, "linked-dir"))
        await fs.symlink(path.join(root, "nested", ".env"), path.join(root, ".env.inside"))
      })
      const env = yield* start
      expect(yield* env.current({ root, deep: true })).toEqual([
        "deep-value-0123456",
        "local-value-012345",
        "nested-value-01234",
        "production-0123456",
        "root-value-0123456",
      ])
    }),
  )

  it.live("reads only the .env files right in the folder of a chat in no project", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* write(root, { ".env": "OWN=own-value-0123456\n", "child/.env": "CHILD=child-value-012345\n" })
      const env = yield* start
      expect(yield* env.current({ root, deep: false })).toEqual(["own-value-0123456"])
    }),
  )

  it.live("reads none in the home folder or a folder that holds it", () =>
    Effect.gen(function* () {
      const home = (yield* tmpdirScoped()).path
      yield* write(home, { ".env": "HOME_VALUE=home-value-0123456\n", "project/.env": "IN=project-value-01234\n" })
      const env = yield* start
      yield* withEnv({ OPENCODE_TEST_HOME: home }, () =>
        Effect.gen(function* () {
          expect(yield* env.current({ root: home, deep: false })).toEqual([])
          expect(yield* env.current({ root: home, deep: true })).toEqual([])
          expect(yield* env.current({ root: path.dirname(home), deep: true })).toEqual([])
          expect(yield* env.current({ root: "/", deep: true })).toEqual([])
          expect(yield* env.current({ root: "/", deep: false })).toEqual([])
          // A repository inside the home folder is read as any.
          expect(yield* env.current({ root: path.join(home, "project"), deep: true })).toEqual(["project-value-01234"])
        }),
      )
    }),
  )

  it.live("keeps a set current: a value changed, a file made at the root or beside an example, a file removed", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* write(root, { "README.md": "docs\n", "apps/web/.env.example": "EXAMPLE=example-0123456789\n" })
      const env = yield* start
      const place = { root, deep: true }
      expect(yield* env.current(place)).toEqual([])

      yield* write(root, { ".env": "FIRST=first-value-0123\n" })
      expect(yield* env.current(place)).toEqual(["first-value-0123"])

      yield* write(root, { ".env": "FIRST=changed-value-012345\n" })
      expect(yield* env.current(place)).toEqual(["changed-value-012345"])

      yield* write(root, { "apps/web/.env.local": "WEB=web-local-0123456\n" })
      expect(yield* env.current(place)).toEqual(["changed-value-012345", "web-local-0123456"])

      yield* Effect.promise(() => fs.rm(path.join(root, ".env")))
      expect(yield* env.current(place)).toEqual(["web-local-0123456"])
    }),
  )

  it.live("takes a .env file a tool call named, in a folder that held none, from the next look on", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* write(root, { ".env": "ROOT=root-value-0123456\n" })
      const env = yield* start
      const place = { root, deep: true }
      expect(yield* env.current(place)).toEqual(["root-value-0123456"])

      // A tool writes it, named absolutely or from the chat's folder, as write tools and shell commands name files.
      yield* write(root, {
        "packages/fresh/.env": "FRESH=fresh-value-0123456\n",
        "services/other/.env.local": "OTHER=other-value-0123456\n",
      })
      yield* env.named(place, { filePath: path.join(root, "packages/fresh/.env") }, root)
      yield* env.named(place, { command: "printf 'OTHER=…' > services/other/.env.local && cat it" }, root)
      expect(yield* env.current(place)).toEqual(["fresh-value-0123456", "other-value-0123456", "root-value-0123456"])
    }),
  )
})
