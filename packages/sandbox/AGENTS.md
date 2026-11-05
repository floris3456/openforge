# Sandbox

Confines the shell commands an agent runs: by default they read everywhere except openforge's credentials and service
passwords, write only to the chat's folder, its git folders, the temp folders, the package caches and `/dev`, and keep
the network. It depends on `@opencode/schema` only, never on the runner or Core.

## Use

- `Sandbox.merge(...layers)` layers the `sandbox` settings: the config documents from lowest to highest priority, then
  the agent's (`Agent.Info.sandbox`, which already merges the agent's own layers). It is `ConfigSandbox.merge`.
- `Sandbox.resolve(settings, context)` gives a concrete `Policy` of resolved paths. `context` takes `Global.Path`'s
  `home`, `data`, `state` and `config`, plus the chat's `directory`, its checkout (`worktree`) and the command's `env`.
- `Sandbox.wrap(policy, argv, selfCommand())` gives the argv to spawn, `{ type: "refuse" }` when the machine can't
  sandbox and `sandbox.required` is set, or an unsandboxed argv whose `warning` is set once per process.
- `Sandbox.note(policy)` is the text added to a failed sandboxed command's result.
- `Sandbox.permission` (`ConfigSandbox.permission`, `unsandboxed`, default ask in `Agent.Info.default`) guards
  `sandbox: false`.
- Core uses it in `ShellWrap.configured` (`packages/core/src/shell/wrap.ts`), for the shell tool's commands only (not
  `!` or the shell API). The server turns it on when the CLI passes `sandbox.command` (`selfCommand()`).

## How

- Linux: `openforge sandbox-exec <policy> -- <argv…>` (`src/exec.ts`, dispatched by `packages/cli/src/index.ts` before
  the CLI loads) calls `Landlock.confine` and execs the command. Landlock handles every filesystem right, grants
  reading by granting the siblings along the way to each denied path, and writing beneath the write list. With the
  network off, a seccomp filter refuses IPv4 and IPv6 sockets. `bun:ffi` goes through `#native`, which is a stub
  under Node. `sandbox-exec` loads only `src/exec.ts` and what it imports, so keep those free of `@opencode/*`.
- macOS: `/usr/bin/sandbox-exec -p <profile>`; `Seatbelt.profile` allows by default and denies the rest.
- `src/files.ts` holds the filesystem reads of `resolve` and of the Landlock rules; a read that fails finds nothing.

## Limits

- It guards against mistakes, not a hostile model: local services, Unix sockets and signals are not blocked.
- On Linux, a file created later right in a folder on the way to a denied path is unreadable until the next command.
- On Linux, `> /dev/stdout` reopens the file behind fd 1, so give commands pipes, not a regular file outside the
  write list, as their output.

## Tests

`bun test` from this folder. `test/sandbox.test.ts` covers the policies, the Landlock rules, the seccomp filter and
the Seatbelt profile without sandboxing anything. `test/enforce.test.ts` runs the cases of `test/fixture/scenarios.ts`
against real sandboxed processes: where a command may write and read, its grandchildren, the network switched off,
a git worktree, the read and off modes, what reaches the command, and failing closed without Landlock.
`OPENFORGE_BINARY=<compiled openforge>` runs them through a compiled binary.

`test/fixture/proof.ts` is the same cases, plus a start-up benchmark, as one program that also runs compiled on the
Mac: `bun build --compile test/fixture/proof.ts`, then `proof run <root> [openforge]` and
`proof bench <root> [openforge]`, with `<root>` a folder that doesn't exist yet, outside every temp folder.
