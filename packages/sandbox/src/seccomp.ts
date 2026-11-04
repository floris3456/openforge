export * as Seccomp from "./seccomp.js"

// A classic BPF program for seccomp that refuses socket() for IPv4 and IPv6 with EACCES and allows every other call,
// so "network off" covers UDP (and DNS over it) too, which Landlock before ABI 10 does not. AF_UNIX stays allowed.

const LD_W_ABS = 0x20
const JEQ_K = 0x15
const RET_K = 0x06
const ALLOW = 0x7fff0000
const EACCES = 13
const DENY = 0x00050000 | EACCES
const AF_INET = 2
const AF_INET6 = 10
// struct seccomp_data { int nr; __u32 arch; __u64 instruction_pointer; __u64 args[6]; }
const NR = 0
const ARCH = 4
const ARG0 = 16

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

type Line = {
  readonly code: number
  readonly k: number
  readonly jt?: string
  readonly jf?: string
  readonly label?: string
}

/** The filter for `arch` (this machine's by default), 8 bytes per instruction. */
export function network(arch: string = process.arch) {
  const target = arch === "x64" || arch === "arm64" ? architectures[arch] : undefined
  if (!target) throw new Error(`no seccomp filter for ${arch}`)
  const sockets = (numbers: readonly number[]) => numbers.map((nr) => jeq(nr, "domain"))
  return assemble([
    load(ARCH),
    jeq(target.arch, undefined, "compat"),
    load(NR),
    ...sockets(target.socket),
    ret(ALLOW),
    { ...jeq(target.compat.arch, undefined, "deny"), label: "compat" },
    load(NR),
    ...sockets(target.compat.socket),
    ...target.compat.refuse.map((nr) => jeq(nr, "deny")),
    ret(ALLOW),
    { ...load(ARG0), label: "domain" },
    jeq(AF_INET, "deny"),
    jeq(AF_INET6, "deny"),
    ret(ALLOW),
    { ...ret(DENY), label: "deny" },
  ])
}

const load = (offset: number): Line => ({ code: LD_W_ABS, k: offset })
const jeq = (k: number, jt?: string, jf?: string): Line => ({ code: JEQ_K, k, jt, jf })
const ret = (k: number): Line => ({ code: RET_K, k })

function assemble(lines: readonly Line[]) {
  const labels = new Map(lines.flatMap((line, index) => (line.label ? [[line.label, index] as const] : [])))
  const program = new Uint8Array(lines.length * 8)
  const view = new DataView(program.buffer)
  lines.forEach((line, index) => {
    const jump = (label?: string) => (label === undefined ? 0 : labels.get(label)! - index - 1)
    view.setUint16(index * 8, line.code, true)
    view.setUint8(index * 8 + 2, jump(line.jt))
    view.setUint8(index * 8 + 3, jump(line.jf))
    view.setUint32(index * 8 + 4, line.k, true)
  })
  return program
}
