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
 * kernel-LPE / sandbox-escape primitive syscalls (Tier A + Tier B) are turned
 * into an errno; everything else — including the namespace/mount/prctl/seccomp
 * calls our nested pressure-vessel and wine need — is allowed automatically.
 * Blocked calls return `SECCOMP_RET_ERRNO` (not KILL) with a per-syscall errno:
 * ENOSYS so a probing game gets a clean "not implemented" and degrades, or
 * EPERM where a permission-denied is the honest failure (NUMA/userfaultfd/perf).
 *
 * Three protection LEVELS select how much is blocked (cumulative, low ⊂ medium
 * ⊂ high):
 *   low    — the Tier-A kernel-LPE / escape primitives only (all ENOSYS).
 *   medium — low + the NUMA memory-policy family, userfaultfd, perf_event_open
 *            (EPERM) and the io_uring trio (ENOSYS). This is the DEFAULT.
 *   high   — medium + calls that may genuinely break some titles: ptrace,
 *            name_to_handle_at, pidfd_getfd, process_madvise and
 *            set_mempolicy_home_node (EPERM); clone3 and memfd_secret (ENOSYS);
 *            plus an argument-filtered personality (only benign personas pass).
 */

import type { Game, UserPreferences } from "@types";

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
// args[0] is a u64 at offset 16; cBPF only loads 32-bit words, so its low and
// high halves are read separately when a syscall needs argument filtering.
const SECCOMP_DATA_ARG0_LOW_OFFSET = 16;
const SECCOMP_DATA_ARG0_HIGH_OFFSET = 20;

// --- Audit arch tokens (uapi/linux/audit.h). ---
export const AUDIT_ARCH_X86_64 = 0xc000003e;
export const AUDIT_ARCH_I386 = 0x40000003;

// --- seccomp return actions (uapi/linux/seccomp.h). ---
export const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_DATA = 0x0000ffff;

// errno values a blocked syscall can be made to return. ENOSYS makes a probing
// game see "not implemented" and degrade; EPERM mimics a kernel/LSM denial
// (e.g. vm.unprivileged_userfaultfd=0) where "permission denied" is the honest,
// expected failure.
export const ENOSYS = 38;
export const EPERM = 1;

/** SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA) = 0x00050026. */
export const SECCOMP_RET_ERRNO_ENOSYS =
  (SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)) >>> 0;
/** SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA) = 0x00050001. */
export const SECCOMP_RET_ERRNO_EPERM =
  (SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)) >>> 0;
/** SECCOMP_RET_LOG — allow the syscall but log it (kernel audit / dmesg line
 *  carries the arch + syscall nr). Audit mode swaps every block action to this
 *  so a game runs unfiltered while each would-be block is recorded. */
export const SECCOMP_RET_LOG = 0x7ffc0000;

// --- Protection levels. ---

/** Sandbox seccomp protection levels; cumulative (low ⊂ medium ⊂ high). */
export type ProtectionLevel = "low" | "medium" | "high";

/** Weakest→strongest; also the settings-UI dropdown order. */
export const PROTECTION_LEVELS: ProtectionLevel[] = ["low", "medium", "high"];

/** Level used when a caller passes none. Wired through to callers in a later
 *  pass (settings dropdown + per-game override); the build API defaults here. */
export const DEFAULT_PROTECTION_LEVEL: ProtectionLevel = "medium";

const LEVEL_RANK: Record<ProtectionLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** How the filter reacts to a matched syscall. `enforce` returns the per-rule
 *  errno (ENOSYS/EPERM); `audit` allows the call but logs it via SECCOMP_RET_LOG
 *  so breakage can be diagnosed without changing behavior. */
export type FilterMode = "enforce" | "audit";

/** Mode used when a caller passes none. */
export const DEFAULT_FILTER_MODE: FilterMode = "enforce";

/** Per-game seccomp override value. `"off"` disables the filter for that game;
 *  a {@link ProtectionLevel} overrides the global level. `null`/`undefined`
 *  (handled by {@link resolveSeccomp}) means "follow the global preference". */
export type GameSeccompLevel = "off" | ProtectionLevel;

/** Fully-resolved seccomp decision for one sandboxed launch. */
export interface SeccompResolution {
  /** False when no `--seccomp` filter must be attached to the launch. */
  enabled: boolean;
  /** Effective protection level (meaningful only when `enabled`). */
  level: ProtectionLevel;
  /** Effective filter mode; `"audit"` only via the per-game diagnostic flag. */
  mode: FilterMode;
  /** Whether the ON/OFF + level decision came from the per-game override or the
   *  global preference. For launch logging only. */
  source: "game" | "global";
}

/**
 * Resolves the effective seccomp state for a launch from the global preference
 * and the per-game override, mirroring {@link isNetworkIsolationEnabled}'s
 * tri-state precedence (per-game wins over global, in both directions):
 *   - per-game `"off"`               → disabled (this game only)
 *   - per-game `"low"/"medium"/"high"` → enabled at that level (wins over the
 *                                        global level AND the global kill-switch)
 *   - no per-game level + global `disableSeccomp` → disabled
 *   - otherwise                      → enabled at the global level
 *                                      ({@link DEFAULT_PROTECTION_LEVEL} default)
 * The per-game diagnostic flag (`seccompAudit`) independently selects AUDIT mode
 * whenever a filter is attached — it never turns the filter on by itself. Kept
 * pure (electron-free, `@types` is a type-only import) so it stays unit-testable
 * alongside {@link buildSeccompFilter}.
 */
export const resolveSeccomp = (
  userPreferences:
    | Pick<UserPreferences, "disableSeccomp" | "seccompLevel">
    | null
    | undefined,
  game: Pick<Game, "seccompLevel" | "seccompAudit"> | null | undefined
): SeccompResolution => {
  const globalLevel = userPreferences?.seccompLevel ?? DEFAULT_PROTECTION_LEVEL;
  const mode: FilterMode = game?.seccompAudit === true ? "audit" : "enforce";
  const gameLevel = game?.seccompLevel;

  if (gameLevel === "off") {
    return { enabled: false, level: globalLevel, mode, source: "game" };
  }

  if (gameLevel === "low" || gameLevel === "medium" || gameLevel === "high") {
    return { enabled: true, level: gameLevel, mode, source: "game" };
  }

  if (userPreferences?.disableSeccomp === true) {
    return { enabled: false, level: globalLevel, mode, source: "global" };
  }

  return { enabled: true, level: globalLevel, mode, source: "global" };
};

/** Per-arch syscall numbers, the errno a blocked call returns, and the lowest
 *  protection level that blocks it. `i386` is null when that arch has no such
 *  syscall (nothing to block there). `level` omitted = "low"; `errno` omitted =
 *  ENOSYS — so Tier-A entries stay bare and unchanged. */
export interface SyscallNumbers {
  x86_64: number;
  i386: number | null;
  /** Lowest level that blocks this call; omitted = "low" (Tier-A default). */
  level?: ProtectionLevel;
  /** errno via SECCOMP_RET_ERRNO; omitted = ENOSYS (Tier-A default). */
  errno?: number;
  /**
   * When set, matching this syscall number does not deny outright but jumps to
   * a dedicated argument-filter block; only "personality" exists today (see the
   * PERSONALITY_* values). `errno` is then the fallback for rejected arguments.
   */
  argFilter?: "personality";
}

/**
 * The blocklist — single source of truth for both arches, errnos and levels.
 * Numbers VERIFIED against the host uapi headers on 2026-07-08:
 *   - x86_64: /usr/include/asm/unistd_64.h
 *   - i386:   /usr/include/asm/unistd_32.h
 * `kexec_file_load` has no `__NR_` on i386 (x86_64-only), so its i386 entry is
 * null. The sandbox-seccomp.test.ts host-header cross-check re-derives every
 * entry from the headers so a wrong number is caught in CI on hosts that ship
 * them. Everything unlisted is ALLOWED.
 *
 * Tier A (level "low", ENOSYS): kernel-LPE / sandbox-escape primitives never
 * legitimately needed by games. Tier B extends this at higher levels.
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

  // --- Tier B, level "medium". ---
  // NUMA memory-policy family (EPERM) — flatpak blocks the whole set in its base
  // filter applied to every app incl. Steam; not needed by games and a
  // kernel-attack surface. EPERM matches flatpak's semantics.
  mbind: { x86_64: 237, i386: 274, level: "medium", errno: EPERM },
  set_mempolicy: { x86_64: 238, i386: 276, level: "medium", errno: EPERM },
  get_mempolicy: { x86_64: 239, i386: 275, level: "medium", errno: EPERM },
  migrate_pages: { x86_64: 256, i386: 294, level: "medium", errno: EPERM },
  move_pages: { x86_64: 279, i386: 317, level: "medium", errno: EPERM },
  // userfaultfd (EPERM) — userspace page-fault handling, a classic
  // exploit-timing primitive. Mimics the kernel's vm.unprivileged_userfaultfd=0.
  userfaultfd: { x86_64: 323, i386: 374, level: "medium", errno: EPERM },
  // perf_event_open (EPERM) — perf subsystem; flatpak's nondevel filter denies
  // it as a recurring LPE surface.
  perf_event_open: { x86_64: 298, i386: 336, level: "medium", errno: EPERM },
  // io_uring (ENOSYS) — powerful async-I/O ring, disabled on hardened kernels
  // (e.g. RHEL default). ENOSYS mimics a kernel built without it so games fall
  // back. The trio lives in the unified >=425 range: same numbers on both.
  io_uring_setup: { x86_64: 425, i386: 425, level: "medium" },
  io_uring_enter: { x86_64: 426, i386: 426, level: "medium" },
  io_uring_register: { x86_64: 427, i386: 427, level: "medium" },

  // --- Tier B, level "high" (may genuinely break some titles). ---
  // ptrace (EPERM) — anti-cheat/overlays sometimes trace; denying can break a
  // few, hence high-only.
  ptrace: { x86_64: 101, i386: 26, level: "high", errno: EPERM },
  // clone3 (ENOSYS) — glibc transparently falls back to clone() on ENOSYS;
  // flatpak precedent.
  clone3: { x86_64: 435, i386: 435, level: "high" },
  // personality (EPERM fallback) — ARGUMENT-FILTERED: only PER_LINUX,
  // ADDR_NO_RANDOMIZE and the read-only query pass (see PERSONALITY_*); any
  // other persona is EPERM.
  personality: {
    x86_64: 135,
    i386: 136,
    level: "high",
    errno: EPERM,
    argFilter: "personality",
  },
  // name_to_handle_at (EPERM) — pairs with open_by_handle_at to escape
  // path-based sandboxing.
  name_to_handle_at: { x86_64: 303, i386: 341, level: "high", errno: EPERM },
  // pidfd_getfd (EPERM) — steal an fd from another process by pidfd.
  pidfd_getfd: { x86_64: 438, i386: 438, level: "high", errno: EPERM },
  // process_madvise (EPERM) — advise/manipulate another process's memory.
  process_madvise: { x86_64: 440, i386: 440, level: "high", errno: EPERM },
  // set_mempolicy_home_node (EPERM) — NUMA policy tail; completes the family.
  set_mempolicy_home_node: {
    x86_64: 450,
    i386: 450,
    level: "high",
    errno: EPERM,
  },
  // memfd_secret (ENOSYS) — secret memory not mapped in the kernel direct map;
  // ENOSYS mimics a kernel without CONFIG_SECRETMEM.
  memfd_secret: { x86_64: 447, i386: 447, level: "high" },
};

const BLOCKED_SYSCALL_LIST = Object.entries(BLOCKED_SYSCALLS).map(
  ([name, numbers]) => ({ name, ...numbers })
);

/** Entries blocked at `level`, in table order (cumulative: an entry is included
 *  when its own level is at or below the requested level). */
const includedForLevel = (level: ProtectionLevel) =>
  BLOCKED_SYSCALL_LIST.filter(
    (entry) => LEVEL_RANK[entry.level ?? "low"] <= LEVEL_RANK[level]
  );

/** Names of every syscall blocked at `level` (cumulative). Handy for a settings
 *  UI that lists what each level denies. */
export const blockedSyscallNamesForLevel = (level: ProtectionLevel): string[] =>
  includedForLevel(level).map((entry) => entry.name);

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
const LABEL_DENY_ENOSYS = "deny_enosys";
const LABEL_DENY_EPERM = "deny_eperm";
const LABEL_ALLOW = "allow";
const LABEL_PERSONALITY = "personality_block";
const LABEL_PERSONALITY_HIGH = "personality_high";

// personality(2) personas the "high" arg-filter lets through; every other value
// falls to EPERM. PER_LINUX(0x0) is the default persona; ADDR_NO_RANDOMIZE
// (0x0040000) is commonly set by loaders / pressure-vessel; 0xffffffff is the
// read-only query that returns the current persona without changing it and is
// allowed regardless of the args[0] high word (userspace may sign-extend it).
const PERSONALITY_PER_LINUX = 0x00000000;
const PERSONALITY_ADDR_NO_RANDOMIZE = 0x00040000;
const PERSONALITY_QUERY = 0xffffffff;

/** Deny label an entry's errno routes to. Unset errno → the Tier-A ENOSYS. */
const denyLabelFor = (errno: number | undefined): string =>
  (errno ?? ENOSYS) === EPERM ? LABEL_DENY_EPERM : LABEL_DENY_ENOSYS;

/** Jump target for a matched syscall number: the personality argument-filter
 *  sub-block for arg-filtered entries, otherwise the deny return for its errno.
 *  (In audit mode the deny returns are RET_LOG, so this routing is unchanged.) */
const matchTargetFor = (entry: SyscallNumbers): string =>
  entry.argFilter === "personality"
    ? LABEL_PERSONALITY
    : denyLabelFor(entry.errno);

/**
 * Builds the compiled seccomp cBPF filter for `level` as a Buffer ready to hand
 * to bwrap's `--seccomp <fd>`. Defaults to {@link DEFAULT_PROTECTION_LEVEL} and
 * {@link DEFAULT_FILTER_MODE} so the historical zero-arg call site keeps working
 * unchanged. In `audit` mode the program is structurally identical but every
 * deny return becomes SECCOMP_RET_LOG (allow-and-log) instead of an errno.
 *
 * Layout (default ALLOW, unknown arch ALLOW so non-native arches are never
 * mis-filtered):
 *   load arch
 *   if arch == x86_64  -> x86_64 block
 *   if arch == i386    -> i386 block   else -> allow
 *   [x86_64 block] load nr; for each n: if nr == n -> deny(n.errno)/personality
 *   [i386 block]   load nr; for each n: if nr == n -> deny(n.errno)/personality
 *   [personality]  load args[0]; allow benign personas, else -> deny_eperm
 *   deny_enosys: return ERRNO(ENOSYS)
 *   deny_eperm:  return ERRNO(EPERM)   (emitted only when some entry needs it)
 *   allow:       return ALLOW
 * Each arch block jumps to `allow` on no-match instead of falling into the next
 * block, so an x86_64 syscall whose number collides with an i386 blocklist
 * entry is never wrongly denied. Argument-filtered entries (personality) jump
 * to a shared sub-block instead of a deny return. The EPERM return and the
 * personality block are emitted only when a selected entry needs them, so `low`
 * stays byte-identical to the flat Tier-A filter.
 */
export const buildSeccompFilter = (
  level: ProtectionLevel = DEFAULT_PROTECTION_LEVEL,
  mode: FilterMode = DEFAULT_FILTER_MODE
): Buffer => {
  const entries = includedForLevel(level);
  const usesEperm = entries.some((entry) => (entry.errno ?? ENOSYS) === EPERM);
  const usesPersonality = entries.some(
    (entry) => entry.argFilter === "personality"
  );
  // Audit mode keeps the exact same structure but turns every block action into
  // RET_LOG: the call is allowed and logged, never errored. Only the two deny
  // return constants change, so audit vs enforce differ solely in those slots.
  const denyEnosysAction =
    mode === "audit" ? SECCOMP_RET_LOG : SECCOMP_RET_ERRNO_ENOSYS;
  const denyEpermAction =
    mode === "audit" ? SECCOMP_RET_LOG : SECCOMP_RET_ERRNO_EPERM;

  const program: Instruction[] = [];

  // Arch dispatch.
  program.push(load(SECCOMP_DATA_ARCH_OFFSET));
  program.push(jeq(AUDIT_ARCH_X86_64, LABEL_X86_64, 0));
  program.push(jeq(AUDIT_ARCH_I386, LABEL_I386, LABEL_ALLOW));

  // x86_64 block.
  program.push(load(SECCOMP_DATA_NR_OFFSET, LABEL_X86_64));
  for (const entry of entries) {
    program.push(jeq(entry.x86_64, matchTargetFor(entry), 0));
  }
  program.push(ja(LABEL_ALLOW));

  // i386 block.
  program.push(load(SECCOMP_DATA_NR_OFFSET, LABEL_I386));
  for (const entry of entries) {
    if (entry.i386 === null) continue;
    program.push(jeq(entry.i386, matchTargetFor(entry), 0));
  }
  program.push(ja(LABEL_ALLOW));

  // Argument-filtered personality handler, shared by both arches (args[0] offset
  // and semantics are identical across arch; i386 zero-extends the high word).
  // Emitted only when personality is in the selected set. Benign personas jump
  // straight to `allow` so they are never logged; every other value falls to
  // deny_eperm (RET_LOG in audit mode). See PERSONALITY_* for the accepted set.
  if (usesPersonality) {
    program.push(load(SECCOMP_DATA_ARG0_LOW_OFFSET, LABEL_PERSONALITY));
    // Read-only query (0xffffffff): allow regardless of the high word.
    program.push(jeq(PERSONALITY_QUERY, LABEL_ALLOW, 0));
    // PER_LINUX (0x0) / ADDR_NO_RANDOMIZE (0x0040000): allow only if high == 0.
    program.push(jeq(PERSONALITY_PER_LINUX, LABEL_PERSONALITY_HIGH, 0));
    program.push(
      jeq(
        PERSONALITY_ADDR_NO_RANDOMIZE,
        LABEL_PERSONALITY_HIGH,
        LABEL_DENY_EPERM
      )
    );
    program.push(load(SECCOMP_DATA_ARG0_HIGH_OFFSET, LABEL_PERSONALITY_HIGH));
    program.push(jeq(0x00000000, LABEL_ALLOW, LABEL_DENY_EPERM));
  }

  // Shared returns. The ENOSYS deny is always present (Tier-A is in every
  // level); the EPERM deny is emitted only when a selected entry routes to it
  // (an EPERM syscall or the personality fallback), so a level with no EPERM
  // entry (low) stays byte-identical to the flat Tier-A filter.
  program.push(ret(denyEnosysAction, LABEL_DENY_ENOSYS));
  if (usesEperm) {
    program.push(ret(denyEpermAction, LABEL_DENY_EPERM));
  }
  program.push(ret(SECCOMP_RET_ALLOW, LABEL_ALLOW));

  return assemble(program);
};
