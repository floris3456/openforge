// The Linux system calls the sandbox needs, through the C library. Loaded on first use, so importing this module
// costs nothing on other platforms.
import { dlopen, FFIType, ptr, read } from "bun:ffi"

const SYS = {
  x64: { seccomp: 317n },
  arm64: { seccomp: 277n },
} as const
const SYS_landlock_create_ruleset = 444n
const SYS_landlock_add_rule = 445n
const SYS_landlock_restrict_self = 446n
const LANDLOCK_CREATE_RULESET_VERSION = 1n
const LANDLOCK_RULE_PATH_BENEATH = 1n
const PR_SET_NO_NEW_PRIVS = 38
const PR_GET_SECCOMP = 21
const PR_SET_SECCOMP = 22
const SECCOMP_MODE_FILTER = 2n
const SECCOMP_GET_ACTION_AVAIL = 2n
const SECCOMP_RET_ERRNO = 0x00050000
const O_PATH = 0o10000000
const O_CLOEXEC = 0o2000000

const symbols = {
  syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.u64 },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const

let loaded: ReturnType<typeof load> | undefined
const libc = () => (loaded ??= load())

function load() {
  const names = ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]
  for (const name of names) {
    const library = attempt(() => dlopen(name, symbols))
    if (library) return library.symbols
  }
  throw new Error(`cannot load the C library (${names.join(", ")})`)
}

function attempt<T>(fn: () => T) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function failure(what: string) {
  const c = libc()
  const code = read.i32(c.__errno_location()!)
  return new Error(`${what}: ${c.strerror(code) ?? `errno ${code}`}`)
}

const address = (view: NodeJS.TypedArray) => BigInt(ptr(view))

/** The Landlock ABI version, or 0 when the kernel has no usable Landlock. */
export function landlock() {
  const abi = attempt(() => Number(libc().syscall(SYS_landlock_create_ruleset, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION, 0n)))
  return abi !== undefined && abi > 0 ? abi : 0
}

/** Whether seccomp filters that return an errno can be installed. */
export function seccomp() {
  const numbers = process.arch === "x64" || process.arch === "arm64" ? SYS[process.arch] : undefined
  if (!numbers) return false
  const action = new Uint32Array([SECCOMP_RET_ERRNO])
  return (
    attempt(
      () =>
        libc().prctl(PR_GET_SECCOMP, 0n, 0n, 0n, 0n) >= 0 &&
        Number(libc().syscall(numbers.seccomp, SECCOMP_GET_ACTION_AVAIL, 0n, address(action), 0n)) === 0,
    ) ?? false
  )
}

export function createRuleset(fs: bigint, net: bigint) {
  // struct landlock_ruleset_attr { handled_access_fs, handled_access_net, scoped }; older kernels accept the longer
  // struct when the fields they don't know are zero.
  const attr = new BigUint64Array([fs, net, 0n])
  const fd = Number(libc().syscall(SYS_landlock_create_ruleset, address(attr), BigInt(attr.byteLength), 0n, 0n))
  if (fd < 0) throw failure("landlock_create_ruleset")
  return fd
}

/** Grants `access` beneath `file`. False when the file can't be opened (it vanished, or a parent isn't searchable). */
export function addPathRule(ruleset: number, file: string, access: bigint) {
  const c = libc()
  const fd = c.open(Buffer.from(file + "\0"), O_PATH | O_CLOEXEC)
  if (fd < 0) return false
  // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; } __attribute__((packed))
  const attr = new Uint8Array(12)
  const view = new DataView(attr.buffer)
  view.setBigUint64(0, access, true)
  view.setInt32(8, fd, true)
  const result = Number(c.syscall(SYS_landlock_add_rule, BigInt(ruleset), LANDLOCK_RULE_PATH_BENEATH, address(attr), 0n))
  const error = result < 0 ? failure(`landlock_add_rule ${file}`) : undefined
  c.close(fd)
  if (error) throw error
  return true
}

export function restrictSelf(ruleset: number) {
  const c = libc()
  if (c.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) throw failure("prctl(PR_SET_NO_NEW_PRIVS)")
  if (Number(c.syscall(SYS_landlock_restrict_self, BigInt(ruleset), 0n, 0n, 0n)) !== 0)
    throw failure("landlock_restrict_self")
  c.close(ruleset)
}

/** Installs a classic BPF seccomp filter (8 bytes per instruction) on this thread; execve keeps it. */
export function installFilter(program: Uint8Array) {
  const c = libc()
  if (c.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) throw failure("prctl(PR_SET_NO_NEW_PRIVS)")
  // struct sock_fprog { unsigned short len; struct sock_filter *filter; }
  const fprog = new BigUint64Array([BigInt(program.byteLength / 8), address(program)])
  if (c.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, address(fprog), 0n, 0n) !== 0) throw failure("prctl(PR_SET_SECCOMP)")
}

/** Resets signals to their default action. Bun ignores SIGPIPE and SIGXFSZ, and execve would pass that on. */
export function defaultSignals(signals: readonly number[]) {
  const c = libc()
  for (const signal of signals) c.signal(signal, 0n)
}
