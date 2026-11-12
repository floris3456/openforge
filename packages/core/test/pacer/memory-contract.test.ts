import { afterAll } from "bun:test"
import { memoryContract } from "./memory-contract"
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

memoryContract(
  server
    ? {
        url: server.url,
        key: "contract-key-one",
        person: "floris",
        second: { key: "contract-key-two-k9x2", person: "key-k9x2" },
        embedding: { fake, key: "embedding-key-one" },
        bare: bare?.url,
      }
    : {
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
      },
)
