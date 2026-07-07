/**
 * Pure-Node classic-BPF (cBPF) assembler and the seccomp BLOCKLIST filter that
 * the bwrap sandbox installs via `--seccomp <fd>`.
 *
 * bwrap reads a compiled classic-BPF program — an array of `struct sock_filter`
 * (8 bytes little-endian each: u16 code, u8 jt, u8 jf, u32 k) — from an
 * inherited file descriptor. This module builds that program in pure Node (no
 * Rust addon, no build-system change) so it stays deterministic, unit-decodable
 * and electron-free/testable.
 *
 * The program is a BLOCKLIST with a default-ALLOW: only a small set of
 * kernel-LPE / sandbox-escape primitive syscalls (Tier A) are turned into
 * `ENOSYS`; everything else — including the namespace/mount/prctl/seccomp calls
 * our nested pressure-vessel and wine need — is allowed automatically. Blocked
 * calls return `SECCOMP_RET_ERRNO(ENOSYS)` (not KILL) so a probing game gets a
 * clean "not implemented" and degrades gracefully instead of dying on SIGSYS.
 */

// --- BPF opcode fields (classic BPF, as used by seccomp). ---
const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_JA = 0x00;
const BPF_K = 0x00;
const BPF_RET = 0x06;

const OP_LD_W_ABS = BPF_LD | BPF_W | BPF_ABS; // 0x20 — A = *(u32*)(data + k)
const OP_JEQ_K = BPF_JMP | BPF_JEQ | BPF_K; //   0x15 — pc += (A == k) ? jt : jf
const OP_JA = BPF_JMP | BPF_JA; //               0x05 — pc += k
const OP_RET_K = BPF_RET | BPF_K; //             0x06 — return k

// --- seccomp_data layout: { int nr; u32 arch; u64 ip; u64 args[6]; }. ---
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;

// --- Audit arch tokens (uapi/linux/audit.h). ---
export const AUDIT_ARCH_X86_64 = 0xc000003e;
export const AUDIT_ARCH_I386 = 0x40000003;

// --- seccomp return actions (uapi/linux/seccomp.h). ---
export const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_DATA = 0x0000ffff;
const ENOSYS = 38;
/** SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA) = 0x00050026. */
export const SECCOMP_RET_ERRNO_ENOSYS =
  (SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)) >>> 0;

/** Per-arch syscall numbers for a blocked call. `i386` is null when that arch
 *  has no such syscall (nothing to block there). */
export interface SyscallNumbers {
  x86_64: number;
  i386: number | null;
}

/**
 * Tier-A blocklist — never legitimately needed by games, all real LPE / escape
 * primitives. Numbers VERIFIED against the host uapi headers on 2026-07-07:
 *   - x86_64: /usr/include/asm/unistd_64.h
 *   - i386:   /usr/include/asm/unistd_32.h
 * `kexec_file_load` has no `__NR_` on i386 (x86_64-only), so its i386 entry is
 * null. The sandbox-seccomp.test.ts host-header cross-check re-derives these
 * from the headers so a wrong number is caught in CI on hosts that ship them.
 *
 * Deliberately NOT here (Tier B, held out of v1): perf_event_open, userfaultfd,
 * move_pages/migrate_pages/mbind, io_uring_*. Everything unlisted is ALLOWED.
 */
export const BLOCKED_SYSCALLS: Record<string, SyscallNumbers> = {
  // Kernel keyring — credential/keyring escape surface.
  add_key: { x86_64: 248, i386: 286 },
  request_key: { x86_64: 249, i386: 287 },
  keyctl: { x86_64: 250, i386: 288 },
  // eBPF — the eBPF syscall (unrelated to seccomp/prctl filter install); a
  // classic LPE surface.
  bpf: { x86_64: 321, i386: 357 },
  // Kexec — replace the running kernel.
  kexec_load: { x86_64: 246, i386: 283 },
  kexec_file_load: { x86_64: 320, i386: null },
  // Kernel module (un)loading.
  init_module: { x86_64: 175, i386: 128 },
  finit_module: { x86_64: 313, i386: 350 },
  delete_module: { x86_64: 176, i386: 129 },
  // Raw I/O port access.
  iopl: { x86_64: 172, i386: 110 },
  ioperm: { x86_64: 173, i386: 101 },
  // Swap management.
  swapon: { x86_64: 167, i386: 87 },
  swapoff: { x86_64: 168, i386: 115 },
  // Process accounting.
  acct: { x86_64: 163, i386: 51 },
  // Disk quota control.
  quotactl: { x86_64: 179, i386: 131 },
  // Reboot / power state.
  reboot: { x86_64: 169, i386: 88 },
  // Kernel ring buffer (klog).
  syslog: { x86_64: 103, i386: 103 },
  // Clock / time-of-day tampering.
  settimeofday: { x86_64: 164, i386: 79 },
  clock_settime: { x86_64: 227, i386: 264 },
  clock_adjtime: { x86_64: 305, i386: 343 },
  adjtimex: { x86_64: 159, i386: 124 },
  // Open by (leaked) file handle — bypasses path-based sandboxing.
  open_by_handle_at: { x86_64: 304, i386: 342 },
  // New mount API.
  open_tree: { x86_64: 428, i386: 428 },
  move_mount: { x86_64: 429, i386: 429 },
  fsopen: { x86_64: 430, i386: 430 },
  fsconfig: { x86_64: 431, i386: 431 },
  fsmount: { x86_64: 432, i386: 432 },
  // Legacy / obscure admin syscalls.
  uselib: { x86_64: 134, i386: 86 },
  ustat: { x86_64: 136, i386: 62 },
  nfsservctl: { x86_64: 180, i386: 169 },
  _sysctl: { x86_64: 156, i386: 149 },
};

const BLOCKED_SYSCALL_LIST = Object.entries(BLOCKED_SYSCALLS).map(
  ([name, numbers]) => ({ name, ...numbers })
);

// --- Tiny label-resolving cBPF assembler. ---

type Operand = number | string;

interface Instruction {
  code: number;
  /** True branch (JEQ): instruction count or a label to resolve. */
  jt: Operand;
  /** False branch (JEQ): instruction count or a label to resolve. */
  jf: Operand;
  /** Literal k (LD offset / JEQ compare / RET value), or a label for JA. */
  k: Operand;
  /** Marks this instruction's position so jumps can target it by name. */
  label?: string;
}

const load = (offset: number, label?: string): Instruction => ({
  code: OP_LD_W_ABS,
  jt: 0,
  jf: 0,
  k: offset,
  label,
});

const jeq = (value: number, jt: Operand, jf: Operand): Instruction => ({
  code: OP_JEQ_K,
  jt,
  jf,
  k: value,
});

const ja = (target: string): Instruction => ({
  code: OP_JA,
  jt: 0,
  jf: 0,
  k: target,
});

const ret = (value: number, label?: string): Instruction => ({
  code: OP_RET_K,
  jt: 0,
  jf: 0,
  k: value,
  label,
});

/**
 * Resolves symbolic labels to relative offsets and serializes the program to a
 * Buffer of 8-byte little-endian sock_filter entries. Jump displacements are
 * computed as `targetIndex - (currentIndex + 1)`. cBPF only jumps forward and
 * JEQ jt/jf are u8 instruction counts, so a backward or > 255 displacement is a
 * programming error and throws (the guard the design calls for: a block that
 * ever exceeds 255 instructions must be chained).
 */
const assemble = (program: Instruction[]): Buffer => {
  const labelIndex = new Map<string, number>();
  program.forEach((instruction, index) => {
    if (instruction.label === undefined) return;
    if (labelIndex.has(instruction.label)) {
      throw new Error(`duplicate seccomp label: ${instruction.label}`);
    }
    labelIndex.set(instruction.label, index);
  });

  const resolveJump = (
    operand: Operand,
    from: number,
    field: string
  ): number => {
    let target: number;
    if (typeof operand === "number") {
      target = from + 1 + operand;
    } else {
      const resolved = labelIndex.get(operand);
      if (resolved === undefined) {
        throw new Error(`unknown seccomp label: ${operand}`);
      }
      target = resolved;
    }

    const displacement = target - (from + 1);
    if (displacement < 0) {
      throw new Error(
        `backward seccomp jump not allowed (${field} at ${from} -> ${target})`
      );
    }
    return displacement;
  };

  const buffer = Buffer.alloc(program.length * 8);

  program.forEach((instruction, index) => {
    let jt = 0;
    let jf = 0;
    let k = 0;

    if (instruction.code === OP_JA) {
      // Unconditional jump: k carries the forward displacement (u32, so no 255
      // cap); jt/jf are unused.
      k = resolveJump(instruction.k, index, "k");
    } else {
      if (typeof instruction.k !== "number") {
        throw new Error(`non-jump seccomp instruction needs a numeric k`);
      }
      k = instruction.k;
      jt = resolveJump(instruction.jt, index, "jt");
      jf = resolveJump(instruction.jf, index, "jf");
      if (jt > 0xff || jf > 0xff) {
        throw new Error(
          `seccomp jump displacement exceeds 255 (jt=${jt} jf=${jf} at ${index}); block must be chained`
        );
      }
    }

    const offset = index * 8;
    buffer.writeUInt16LE(instruction.code & 0xffff, offset);
    buffer.writeUInt8(jt & 0xff, offset + 2);
    buffer.writeUInt8(jf & 0xff, offset + 3);
    buffer.writeUInt32LE(k >>> 0, offset + 4);
  });

  return buffer;
};

const LABEL_X86_64 = "x86_64_block";
const LABEL_I386 = "i386_block";
const LABEL_DENY = "deny";
const LABEL_ALLOW = "allow";

/**
 * Builds the compiled Tier-A seccomp cBPF filter as a Buffer ready to hand to
 * bwrap's `--seccomp <fd>`.
 *
 * Layout (default ALLOW, unknown arch ALLOW so non-native arches are never
 * mis-filtered):
 *   load arch
 *   if arch == x86_64  -> x86_64 block
 *   if arch == i386    -> i386 block   else -> allow
 *   [x86_64 block] load nr; for each n: if nr == n -> deny; else -> allow
 *   [i386 block]   load nr; for each n: if nr == n -> deny; else -> allow
 *   deny:  return ERRNO(ENOSYS)
 *   allow: return ALLOW
 * Each arch block jumps to `allow` on no-match instead of falling into the next
 * block, so an x86_64 syscall whose number collides with an i386 blocklist
 * entry is never wrongly denied.
 */
export const buildSeccompFilter = (): Buffer => {
  const program: Instruction[] = [];

  // Arch dispatch.
  program.push(load(SECCOMP_DATA_ARCH_OFFSET));
  program.push(jeq(AUDIT_ARCH_X86_64, LABEL_X86_64, 0));
  program.push(jeq(AUDIT_ARCH_I386, LABEL_I386, LABEL_ALLOW));

  // x86_64 block.
  program.push(load(SECCOMP_DATA_NR_OFFSET, LABEL_X86_64));
  for (const entry of BLOCKED_SYSCALL_LIST) {
    program.push(jeq(entry.x86_64, LABEL_DENY, 0));
  }
  program.push(ja(LABEL_ALLOW));

  // i386 block.
  program.push(load(SECCOMP_DATA_NR_OFFSET, LABEL_I386));
  for (const entry of BLOCKED_SYSCALL_LIST) {
    if (entry.i386 === null) continue;
    program.push(jeq(entry.i386, LABEL_DENY, 0));
  }
  program.push(ja(LABEL_ALLOW));

  // Shared returns.
  program.push(ret(SECCOMP_RET_ERRNO_ENOSYS, LABEL_DENY));
  program.push(ret(SECCOMP_RET_ALLOW, LABEL_ALLOW));

  return assemble(program);
};
