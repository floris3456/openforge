import { describe, expect, test } from "bun:test"
import { repositoryInputs } from "../../../../script/openforge/inputs"

describe("repositoryInputs", () => {
  const root = "/repo"
  const cli = "/repo/packages/cli"

  test("the bundler's keys, relative to packages/cli, become repository paths, sorted and once each", () => {
    expect(
      repositoryInputs(
        [
          "src/index.ts",
          "../core/src/models-dev/snapshot.txt",
          "../tui/src/app.tsx",
          "../core/src/models-dev/snapshot.txt",
          ".cache/bun-app-archive.bin",
        ],
        cli,
        root,
      ),
    ).toEqual([
      "packages/cli/.cache/bun-app-archive.bin",
      "packages/cli/src/index.ts",
      "packages/core/src/models-dev/snapshot.txt",
      "packages/tui/src/app.tsx",
    ])
  })

  test("installed packages, files outside the repository and plugins' virtual modules are left out", () => {
    expect(
      repositoryInputs(
        [
          "../../node_modules/.bun/effect@4.0.6/node_modules/effect/dist/index.js",
          "../core/node_modules/x/index.js",
          "../../../elsewhere/file.ts",
          "/usr/lib/file.ts",
          "opencode:opencode-app-assets",
          "/repo/packages/server/src/server.ts",
        ],
        cli,
        root,
      ),
    ).toEqual(["packages/server/src/server.ts"])
  })
})
