import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv, stopLeftovers } from "./fixture/environment"

// `openforge cpp` (workspace spec docs/specs/cpp-inspect-cli.md, sections 1, 5 and 7) against a stand-in service that
// records what it gets: each command's arguments become its route and fields, the answer is printed as it came, the
// next page is the command as given with the cursor, refusals exit 1 and wrong arguments 2, and every text the CLI
// says itself. The CLI runs from source in an isolated home, so no service of the machine is reached or started.

const TOKEN = "inspect-test-token"
const PASSWORD = "inspect-test-password"
const PREFIX = "/api/experimental/pacer/inspect/"
const FORBIDDEN =
  "This client key may not use the memory of project closed: the owner allows it on CLIProxyPacer's Projects page."
const NO_CPP = "openforge has no CLIProxyPacer set up: openforge auth login cliproxypacer."

type Seen = { readonly path: string; readonly authorization: string | null }

let root = ""
let service: ReturnType<typeof Bun.serve> | undefined
const seen: Seen[] = []
const url = () => `http://127.0.0.1:${service?.port}`

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cpp-cli-"))
  service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer })
})

afterAll(async () => {
  await service?.stop(true)
  const leftovers = stopLeftovers(root)
  await fs.rm(root, { recursive: true, force: true })
  expect(leftovers).toEqual([])
})

function answer(request: Request) {
  const at = new URL(request.url)
  const authorization = request.headers.get("authorization")
  seen.push({ path: at.pathname + at.search, authorization })
  if (at.pathname === "/api/info") return Response.json({ version: OPENCODE_VERSION })
  const opened = authorization === `Bearer ${TOKEN}` || authorization === `Basic ${btoa(`opencode:${PASSWORD}`)}`
  if (!opened) return Response.json({ error: { type: "unauthorized", message: "no" } }, { status: 401 })
  const route = at.pathname.slice(PREFIX.length)
  if (route === "projects/closed/goals")
    return Response.json({ error: { type: "project_forbidden", message: FORBIDDEN } }, { status: 403 })
  if (route === "projects/unset/goals")
    return Response.json({ error: { type: "not_set_up", message: NO_CPP } }, { status: 503 })
  if (at.searchParams.get("format") !== "text") return Response.json({ route, next: "c1.50" })
  return new Response(`answer of ${route}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(route.endsWith("/tasks") ? { "x-pacer-next": "c1.50" } : {}),
    },
  })
}

/** Runs `openforge cpp <args>` in a chat of the stand-in service (its address and token), or with `env` instead. */
async function cpp(args: string[], env: Record<string, string | undefined> = chat()) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), "cpp", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      OPENCODE_SESSION_ID: undefined,
      OPENFORGE_CPP_URL: undefined,
      OPENFORGE_CPP_TOKEN: undefined,
      ...env,
    }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const chat = (token = TOKEN) => ({
  OPENCODE_SESSION_ID: "ses_cpp_test",
  OPENFORGE_CPP_URL: url(),
  OPENFORGE_CPP_TOKEN: token,
})

/** The requests of inspection route `route` (its path without the query). */
const reached = (route: string) => seen.filter((item) => item.path.split("?")[0] === `${PREFIX}${route}`)

describe("openforge cpp", () => {
  test(
    "sends each command's arguments as its route and fields, and prints the answer with the next page's command",
    async () => {
      const runs = await Promise.all([
        cpp(["projects", "--all", "--cursor", "c0"]),
        cpp(["tasks", "theorysnap", "--cursor", "c0", "--state", "all", "--query", "rotate keys", "--limit", "10"]),
        cpp(["goals", "Theory Snap", "--all", "--json"]),
        cpp(["read", "t1", "e2", "g3"]),
        cpp(["review", "t/1"]),
        cpp([
          "recall",
          "theorysnap",
          "key",
          "rotation",
          "--scope",
          "task:t1",
          "--kind",
          "verified",
          "--kind",
          "words",
          "--limit",
          "3",
        ]),
        cpp([
          "entries",
          "theorysnap",
          "--role",
          "build",
          "--task",
          "t1",
          "--kind",
          "verified",
          "--state",
          "all",
          "--limit",
          "5",
        ]),
        // All four kinds, the person's decisions among them (workspace spec `docs/specs/decisions-in-memory.md`).
        cpp([
          "recall",
          "dictu-evals",
          "badge",
          ...["words", "unverified", "verified", "decision"].flatMap((kind) => ["--kind", kind]),
        ]),
      ])
      expect(runs.map((run) => [run.exitCode, run.stderr])).toEqual(runs.map(() => [0, ""]))
      const paths = [
        "projects?all=1&cursor=c0&format=text",
        "projects/theorysnap/tasks?state=all&query=rotate+keys&limit=10&cursor=c0&format=text",
        "projects/Theory%20Snap/goals?all=1",
        "items?ids=t1%2Ce2%2Cg3&format=text",
        "tasks/t%2F1/review?format=text",
        "projects/theorysnap/recall?q=key+rotation&scope=task%3At1&kind=verified%2Cwords&limit=3&format=text",
        "projects/theorysnap/entries?role=build&task=t1&kind=verified&state=all&limit=5&format=text",
        "projects/dictu-evals/recall?q=badge&kind=words%2Cunverified%2Cverified%2Cdecision&format=text",
      ]
      for (const one of paths)
        expect(reached(one.split("?")[0]!)).toEqual([{ path: `${PREFIX}${one}`, authorization: `Bearer ${TOKEN}` }])

      expect(runs[0]!.stdout).toBe("answer of projects\n")
      // The text as it came, then the command as given with the next cursor in place of the one before.
      expect(runs[1]!.stdout).toBe(
        [
          "answer of projects/theorysnap/tasks",
          "Next page: openforge cpp tasks theorysnap --state all --query 'rotate keys' --limit 10 --cursor c1.50",
          "",
        ].join("\n"),
      )
      // --json: CLIProxyPacer's JSON as it came, with its `next`.
      expect(JSON.parse(runs[2]!.stdout)).toEqual({ route: "projects/Theory%20Snap/goals", next: "c1.50" })
      expect(runs[4]!.stdout).toBe("answer of tasks/t%2F1/review\n")
    },
    { timeout: 60_000 },
  )

  test(
    "prints a refusal as it came and exits 1, and exits 2 on wrong arguments",
    async () => {
      const [closed, closedJson, unset, missing, notANumber] = await Promise.all([
        cpp(["goals", "closed"]),
        cpp(["goals", "closed", "--json"]),
        cpp(["goals", "unset"]),
        cpp(["tasks"]),
        cpp(["tasks", "theorysnap", "--limit", "many"]),
      ])
      expect(closed).toEqual({ stdout: "", stderr: `${FORBIDDEN}\n`, exitCode: 1 })
      expect(closedJson.exitCode).toBe(1)
      expect(JSON.parse(closedJson.stdout)).toEqual({ error: { type: "project_forbidden", message: FORBIDDEN } })
      expect(unset).toEqual({ stdout: "", stderr: `${NO_CPP}\n`, exitCode: 1 })
      expect([missing.exitCode, notANumber.exitCode]).toEqual([2, 2])
      expect(missing.stdout + missing.stderr).toContain("openforge cpp tasks")
      expect(seen.filter((item) => item.path.includes("many"))).toEqual([])
    },
    { timeout: 60_000 },
  )

  test(
    "says what it can't reach: a token of an earlier start, no network, no token in a chat; outside a chat it signs in",
    async () => {
      const closedPort = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
      const nowhere = `http://127.0.0.1:${closedPort.port}`
      await closedPort.stop(true)
      const [stale, offline, tokenless, terminal] = await Promise.all([
        cpp(["review", "t-stale"], chat("earlier-token")),
        cpp(["review", "t-offline"], { ...chat(), OPENFORGE_CPP_URL: nowhere }),
        cpp(["review", "t-tokenless"], { OPENCODE_SESSION_ID: "ses_cpp_test", OPENFORGE_CPP_TOKEN: undefined }),
        cpp(["review", "t-terminal", "--server", url()], {
          OPENCODE_PASSWORD: PASSWORD,
          OPENFORGE_CPP_TOKEN: undefined,
        }),
      ])
      expect(stale).toEqual({
        stdout: "",
        stderr: "openforge's service restarted since this command began: run it again.\n",
        exitCode: 1,
      })
      expect(offline).toEqual({
        stdout: "",
        stderr:
          "This command's sandbox has no network, so openforge's service can't be reached: run it with the network on.\n",
        exitCode: 1,
      })
      expect(tokenless).toEqual({
        stdout: "",
        stderr:
          "openforge's service can't be reached from here: run this in an openforge chat or in your own terminal.\n",
        exitCode: 1,
      })
      expect(reached("tasks/t-tokenless/review")).toEqual([])
      expect(terminal).toEqual({ stdout: "answer of tasks/t-terminal/review\n", stderr: "", exitCode: 0 })
      expect(reached("tasks/t-terminal/review")).toEqual([
        {
          path: `${PREFIX}tasks/t-terminal/review?format=text`,
          authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
        },
      ])
    },
    { timeout: 60_000 },
  )
})
