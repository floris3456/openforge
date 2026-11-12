import { afterAll } from "bun:test"
import { memoryContract } from "./memory-contract"
import { startMemoryServer } from "./memory-server"

// MEMORY_CONTRACT_URL and MEMORY_CONTRACT_KEY run the cases against another server (CLIProxyPacer) instead.
const remote = process.env.MEMORY_CONTRACT_URL && process.env.MEMORY_CONTRACT_KEY
const server = remote
  ? undefined
  : startMemoryServer({ keys: [{ key: "contract-key-one", label: "floris" }, { key: "contract-key-two-k9x2" }] })
afterAll(() => server?.stop())

memoryContract(
  server
    ? {
        url: server.url,
        key: "contract-key-one",
        person: "floris",
        second: { key: "contract-key-two-k9x2", person: "key-k9x2" },
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
      },
)
