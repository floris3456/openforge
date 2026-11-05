export * as Seccomp from "./seccomp.js"

// Classic BPF programs for seccomp. `network()` refuses socket() for IPv4 and IPv6 with EACCES and allows every other
// call, so "network off" covers UDP (and DNS over it) too, which Landlock before ABI 10 does not. AF_UNIX stays
// allowed.

/** SECCOMP_RET_ALLOW, and SECCOMP_RET_ERRNO, whose low 16 bits are the errno the call fails with. */
export const Action = { allow: 0x7fff0000, errno: 0x00050000 } as const
/** Offsets in struct seccomp_data { int nr; __u32 arch; __u64 instruction_pointer; __u64 args[6]; }. */
export const Data = { nr: 0, arch: 4, arg0: 16 } as const

const LD_W_ABS = 0x20
const JEQ_K = 0x15
const RET_K = 0x06
const EACCES = 13
const AF_INET = 2
const AF_INET6 = 10

// Each architecture's own ABI and the 32-bit ABI its kernel can also run, with their socket() numbers. x32 shares
// x86_64's audit arch and sets bit 30 of the number; i386 can also create sockets through socketcall(), whose
// arguments a filter can't read, so it is refused whole.
const architectures = {
  x64: {
    arch: 0xc000003e,
    socket: [41, 0x40000000 | 41],
    compat: { arch: 0x40000003, socket: [359], refuse: [102] },
  },
  arm64: {
    arch: 0xc00000b7,
    socket: [198],
    compat: { arch: 0x40000028, socket: [281], refuse: [] },
  },
} as const

/** One instruction; a jump names the `label` of the line it jumps to, or falls through. */
export type Line = {
  readonly code: number
  readonly k: number
  readonly jt?: string
  readonly jf?: string
  readonly label?: string
}

/** The filter for `arch` (this machine's by default). */
export function network(arch: string = process.arch) {
  const target = arch === "x64" || arch === "arm64" ? architectures[arch] : undefined
  if (!target) throw new Error(`no seccomp filter for ${arch}`)
  const sockets = (numbers: readonly number[]) => numbers.map((nr) => jeq(nr, "domain"))
  return assemble([
    load(Data.arch),
    jeq(target.arch, undefined, "compat"),
    load(Data.nr),
    ...sockets(target.socket),
    ret(Action.allow),
    { ...jeq(target.compat.arch, undefined, "deny"), label: "compat" },
    load(Data.nr),
    ...sockets(target.compat.socket),
    ...target.compat.refuse.map((nr) => jeq(nr, "deny")),
    ret(Action.allow),
    { ...load(Data.arg0), label: "domain" },
    jeq(AF_INET, "deny"),
    jeq(AF_INET6, "deny"),
    ret(Action.allow),
    { ...ret(Action.errno | EACCES), label: "deny" },
  ])
}

export const load = (offset: number): Line => ({ code: LD_W_ABS, k: offset })
export const jeq = (k: number, jt?: string, jf?: string): Line => ({ code: JEQ_K, k, jt, jf })
export const ret = (k: number): Line => ({ code: RET_K, k })

/** The program, 8 bytes per instruction, as `installFilter` takes it. */
export function assemble(lines: readonly Line[]) {
  const labels = new Map(lines.flatMap((line, index) => (line.label ? [[line.label, index] as const] : [])))
  const program = new Uint8Array(lines.length * 8)
  const view = new DataView(program.buffer)
  lines.forEach((line, index) => {
    // Classic BPF jumps only forward.
    const jump = (label?: string) => {
      const target = label === undefined ? index + 1 : labels.get(label)
      if (target === undefined || target <= index) throw new Error(`no line labelled ${label} after line ${index}`)
      return target - index - 1
    }
    view.setUint16(index * 8, line.code, true)
    view.setUint8(index * 8 + 2, jump(line.jt))
    view.setUint8(index * 8 + 3, jump(line.jf))
    view.setUint32(index * 8 + 4, line.k, true)
  })
  return program
}
