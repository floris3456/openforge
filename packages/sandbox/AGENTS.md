# Sandbox

Confines the shell commands the tool runner starts (spec: `docs/specs/v0.1.0-tool-runner-and-live-switch.md` in the
workspace, section 2). It depends on `@opencode/schema` only, never on the runner or Core.

## Use

- `Sandbox.merge(...layers)` layers the `sandbox` settings: the config documents from lowest to highest priority, then
  the agent's (`Agent.Info.sandbox`, which already merges the agent's own layers).
- `Sandbox.resolve(settings, context)` gives a concrete `Policy` of resolved paths: plain data that can travel to the
  runner as JSON. `context` takes `Global.Path`'s `home`, `data`, `state` and `config`, plus the chat's `directory`,
  its checkout (`worktree`) and the command's `env`.
- `Sandbox.wrap(policy, argv, selfCommand())` gives the argv to spawn, `{ type: "refuse" }` when the machine can't
  sandbox and `sandbox.required` is set, or an unsandboxed argv whose `warning` is set once per process.
- `Sandbox.note(policy)` is the text added to a failed sandboxed command's result.
- `Sandbox.permission` (`unsandboxed`, default ask in `Agent.Info.default`) guards `sandbox: false`.

## How

- Linux: `openforge sandbox-exec <policy> -- <argv…>` (`src/exec.ts`, dispatched by `packages/cli/src/main.ts` before
  the CLI loads) calls `Landlock.confine` and execs the command. Landlock handles every filesystem right, grants
  reading by granting the siblings along the way to each denied path, and writing beneath the write list. With the
  network off, a seccomp filter refuses IPv4 and IPv6 sockets. `bun:ffi` goes through `#native`, which is a stub
  under Node.
- macOS: `/usr/bin/sandbox-exec -p <profile>`; `Seatbelt.profile` allows by default and denies the rest.

## Limits

- It guards against mistakes, not a hostile model: local services, Unix sockets and signals are not blocked.
- On Linux, a file created later right in a folder on the way to a denied path is unreadable until the next command.
- On Linux, `> /dev/stdout` reopens the file behind fd 1, so give commands pipes, not a regular file outside the
  write list, as their output.

## Tests

`bun test` from this folder. `test/enforce.test.ts` runs the spec's cases (`test/fixture/scenarios.ts`) against real
sandboxed processes; `OPENFORGE_BINARY=<compiled openforge>` runs them through a compiled binary.
`test/fixture/proof.ts` is the same cases, plus a start-up benchmark, as one program that also runs compiled on the
Mac: `bun build --compile test/fixture/proof.ts`, then `proof run <folder outside every temp folder> [openforge]` and
`proof bench [openforge]`.
