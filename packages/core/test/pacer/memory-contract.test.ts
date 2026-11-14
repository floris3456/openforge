import { afterAll } from "bun:test"
import { cppProjects, memoryContract } from "./memory-contract"
import { startFakeEmbedding } from "./memory-embedding"
import { startMemoryServer } from "./memory-server"

// MEMORY_CONTRACT_URL and MEMORY_CONTRACT_KEY run the cases against another server (CLIProxyPacer) instead. That
// server must call the fake embedding endpoint, which then listens on MEMORY_CONTRACT_EMBEDDING_PORT (default 18433):
// it is started with `http://127.0.0.1:<port>/v1`, the model `test-embedding` and, when it sends one, the key
// MEMORY_CONTRACT_EMBEDDING_KEY.
const remote = process.env.MEMORY_CONTRACT_URL && process.env.MEMORY_CONTRACT_KEY
const fake = startFakeEmbedding({ port: remote ? Number(process.env.MEMORY_CONTRACT_EMBEDDING_PORT ?? 18433) : 0 })
const keys = [{ key: "contract-key-one", label: "floris" }, { key: "contract-key-two-k9x2" }]
const server = remote
  ? undefined
  : startMemoryServer({ keys, embedding: { url: fake.url, model: "test-embedding", key: "embedding-key-one" } })
const bare = remote ? undefined : startMemoryServer({ keys })
afterAll(async () => {
  await server?.stop()
  await bare?.stop()
  await fake.stop()
})

// The groups "tasks", "recall log", "prompt" and "summary" run only against a server whose capabilities say `tasks`,
// `recalls`, `prompt` and `summary`, as openforge offers the task tool, sends what followed a search, asks for each
// prompt's entries and sends a compaction's summary only then. The group "projects" runs only against
// the small server, which switches a project's memory in process, and against CLIProxyPacer when
// MEMORY_CONTRACT_MANAGEMENT_KEY names its management key: its switch is its Projects page, and every project a case
// uses is turned on there first, as a new project starts with memory off.
const url = server?.url ?? process.env.MEMORY_CONTRACT_URL!
const capabilities = await fetch(`${url}/pacer/v1/capabilities`, {
  headers: { authorization: `Bearer ${server ? "contract-key-one" : process.env.MEMORY_CONTRACT_KEY}` },
}).then(
  (response) =>
    response.json() as Promise<{
      pacer?: {
        memory?: { tasks?: unknown; recalls?: unknown; projects?: unknown; prompt?: unknown; summary?: unknown }
      }
    }>,
)
const tasks = capabilities.pacer?.memory?.tasks === true
const recalls = capabilities.pacer?.memory?.recalls === true
const projects = capabilities.pacer?.memory?.projects === true
const prompt = capabilities.pacer?.memory?.prompt === true
const summary = capabilities.pacer?.memory?.summary === true
// The group "a moved chat" runs against the small server, and against CLIProxyPacer with its management key once its
// closed answers say `moved` (a project never turned on answers project_memory_off). The subagent's case there needs
// MEMORY_CONTRACT_MODEL, a model it serves: only a model request names a chat's parent to it.
const moves =
  !server &&
  process.env.MEMORY_CONTRACT_MANAGEMENT_KEY !== undefined &&
  (await fetch(`${url}/pacer/v1/memory/contract-probe-${crypto.randomUUID().slice(0, 8)}/export`, {
    headers: { authorization: `Bearer ${process.env.MEMORY_CONTRACT_KEY}` },
  })
    .then((response) => response.json() as Promise<{ error?: { moved?: unknown } }>)
    .then((body) => typeof body.error?.moved === "boolean"))

memoryContract(
  server
    ? {
        tasks,
        recalls,
        projects,
        prompt,
        summary,
        setProject: async (identity, setting) => server.project(identity, setting),
        moves: {
          known: async (chat, key) => server.chat(key, chat),
          subagent: async (chat, parent, key) => server.chat(key, chat, parent),
          move: async (chat, key, identity) => server.move(key, chat, identity),
          id: async (identity) => identity,
        },
        url: server.url,
        key: "contract-key-one",
        person: "floris",
        second: { key: "contract-key-two-k9x2", person: "key-k9x2" },
        embedding: { fake, key: "embedding-key-one" },
        bare: bare?.url,
      }
    : {
        ...(process.env.MEMORY_CONTRACT_MANAGEMENT_KEY
          ? cppProjects({
              url: process.env.MEMORY_CONTRACT_URL!,
              key: process.env.MEMORY_CONTRACT_KEY!,
              management: process.env.MEMORY_CONTRACT_MANAGEMENT_KEY,
              moves,
              model: process.env.MEMORY_CONTRACT_MODEL,
            })
          : {}),
        url: process.env.MEMORY_CONTRACT_URL!,
        key: process.env.MEMORY_CONTRACT_KEY!,
        person: process.env.MEMORY_CONTRACT_PERSON ?? `key-${process.env.MEMORY_CONTRACT_KEY!.slice(-4)}`,
        second: process.env.MEMORY_CONTRACT_KEY2
          ? {
              key: process.env.MEMORY_CONTRACT_KEY2,
              person: process.env.MEMORY_CONTRACT_PERSON2 ?? `key-${process.env.MEMORY_CONTRACT_KEY2.slice(-4)}`,
            }
          : undefined,
        embedding: { fake, key: process.env.MEMORY_CONTRACT_EMBEDDING_KEY },
        tasks,
        recalls,
        projects,
        prompt,
        summary,
      },
)
