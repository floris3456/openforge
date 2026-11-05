import { afterEach, expect, test } from "bun:test"
import { probeResult, serviceUser } from "../src/service-probe"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

test("a service is asked as openforge, one of openforge 0.0.0 to 0.0.3 as opencode", () => {
  for (const version of ["0.0.0", "0.0.1", "0.0.2", "0.0.3"]) expect(serviceUser(version)).toBe("opencode")
  for (const version of ["0.0.4", "0.0.10", "0.1.0", "1.0.0", "local", undefined])
    expect(serviceUser(version)).toBe("openforge")
})

test("the probe sends the user that the registered service's version accepts", async () => {
  const users: string[] = []
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const [user] = atob((request.headers.get("authorization") ?? "").replace("Basic ", "")).split(":")
      users.push(user ?? "")
      return new Response("not found", { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  await probeResult({ url, pid: 1, version: "0.0.3", password: "secret" })
  await probeResult({ url, pid: 1, version: "0.0.4", password: "secret" })
  expect(users).toEqual(["opencode", "openforge"])
})
