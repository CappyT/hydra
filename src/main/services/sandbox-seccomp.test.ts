import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  AUDIT_ARCH_I386,
  AUDIT_ARCH_X86_64,
  BLOCKED_SYSCALLS,
  ENOSYS,
  EPERM,
  PROTECTION_LEVELS,
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO_ENOSYS,
  SECCOMP_RET_ERRNO_EPERM,
  SECCOMP_RET_LOG,
  blockedSyscallNamesForLevel,
  buildSeccompFilter,
  resolveSeccomp,
} from "./sandbox-seccomp.ts";

const UNISTD_64 = "/usr/include/asm/unistd_64.h";
const UNISTD_32 = "/usr/include/asm/unistd_32.h";

// A tiny classic-BPF interpreter covering exactly the opcodes buildSeccompFilter
// emits: LD|W|ABS, JMP|JEQ|K, JMP|JA, RET|K. It reads the seccomp_data fields
// the filter uses: nr (offset 0), arch (offset 4) and args[0] low/high halves
// (offsets 16/20) for the personality argument filter.
const OP_LD_W_ABS = 0x20;
const OP_JEQ_K = 0x15;
const OP_JA = 0x05;
const OP_RET_K = 0x06;

const MODES = ["enforce", "audit"] as const;

type Cell = { code: number; jt: number; jf: number; k: number };
type Instr = {
  code: number;
  jt: number | string;
  jf: number | string;
  k: number | string;
  label?: string;
};

const runFilter = (filter, data) => {
  const count = filter.length / 8;
  let pc = 0;
  let a = 0;
  let steps = 0;

  while (pc < count) {
    if (steps++ > 10000) throw new Error("seccomp filter did not terminate");

    const offset = pc * 8;
    const code = filter.readUInt16LE(offset);
    const jt = filter.readUInt8(offset + 2);
    const jf = filter.readUInt8(offset + 3);
    const k = filter.readUInt32LE(offset + 4);

    if (code === OP_LD_W_ABS) {
      if (k === 0) a = data.nr >>> 0;
      else if (k === 4) a = data.arch >>> 0;
      else if (k === 16) a = (data.arg0Low ?? 0) >>> 0;
      else if (k === 20) a = (data.arg0High ?? 0) >>> 0;
      else throw new Error(`unexpected LD offset ${k}`);
      pc += 1;
    } else if (code === OP_JEQ_K) {
      pc += (a === k ? jt : jf) + 1;
    } else if (code === OP_JA) {
      pc += k + 1;
    } else if (code === OP_RET_K) {
      return k >>> 0;
    } else {
      throw new Error(`unsupported opcode 0x${code.toString(16)}`);
    }
  }

  throw new Error("seccomp filter fell through without a RET");
};

// Decode a filter to a flat list of {code, jt, jf, k} for structural asserts.
const decode = (filter): Cell[] => {
  const out: Cell[] = [];
  for (let index = 0; index < filter.length / 8; index += 1) {
    const offset = index * 8;
    out.push({
      code: filter.readUInt16LE(offset),
      jt: filter.readUInt8(offset + 2),
      jf: filter.readUInt8(offset + 3),
      k: filter.readUInt32LE(offset + 4),
    });
  }
  return out;
};

const parseUnistd = (file) => {
  const map = new Map();
  const content = fs.readFileSync(file, "utf8");
  const pattern = /^#define\s+__NR_(\w+)\s+(\d+)\b/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    map.set(match[1], Number(match[2]));
  }
  return map;
};

// --- Level helpers, re-derived from the table's own level tags. ---
const RANK = { low: 0, medium: 1, high: 2 };
const entriesOf = () =>
  Object.entries(BLOCKED_SYSCALLS).map(([name, numbers]) => ({
    name,
    ...numbers,
  }));
const includedAt = (level, entry) => RANK[entry.level ?? "low"] <= RANK[level];
const expectedErrnoAction = (entry) =>
  (entry.errno ?? ENOSYS) === EPERM
    ? SECCOMP_RET_ERRNO_EPERM
    : SECCOMP_RET_ERRNO_ENOSYS;

// The syscalls each Tier adds, per the (final) design decision.
const TIER_A_NAMES = entriesOf()
  .filter((entry) => entry.level === undefined)
  .map((entry) => entry.name);
const MEDIUM_ADDS = [
  "mbind",
  "set_mempolicy",
  "get_mempolicy",
  "migrate_pages",
  "move_pages",
  "userfaultfd",
  "perf_event_open",
  "io_uring_setup",
  "io_uring_enter",
  "io_uring_register",
];
const HIGH_ADDS = [
  "ptrace",
  "clone3",
  "personality",
  "name_to_handle_at",
  "pidfd_getfd",
  "process_madvise",
  "set_mempolicy_home_node",
  "memfd_secret",
];

// Independent re-implementation of the PRE-levels filter algorithm (single
// ENOSYS deny, single ALLOW, Tier-A list only). Deliberately shares no code
// with the production assembler so it can prove `low` stays byte-identical.
const buildLegacyLowFilter = () => {
  const low = entriesOf().filter((entry) => entry.level === undefined);
  const DENY = "deny";
  const ALLOW = "allow";
  const X = "x86";
  const I = "i386";
  const prog: Instr[] = [];
  prog.push({ code: OP_LD_W_ABS, jt: 0, jf: 0, k: 4 });
  prog.push({ code: OP_JEQ_K, jt: X, jf: 0, k: AUDIT_ARCH_X86_64 });
  prog.push({ code: OP_JEQ_K, jt: I, jf: ALLOW, k: AUDIT_ARCH_I386 });
  prog.push({ code: OP_LD_W_ABS, jt: 0, jf: 0, k: 0, label: X });
  for (const entry of low) {
    prog.push({ code: OP_JEQ_K, jt: DENY, jf: 0, k: entry.x86_64 });
  }
  prog.push({ code: OP_JA, jt: 0, jf: 0, k: ALLOW });
  prog.push({ code: OP_LD_W_ABS, jt: 0, jf: 0, k: 0, label: I });
  for (const entry of low) {
    if (entry.i386 === null) continue;
    prog.push({ code: OP_JEQ_K, jt: DENY, jf: 0, k: entry.i386 });
  }
  prog.push({ code: OP_JA, jt: 0, jf: 0, k: ALLOW });
  prog.push({
    code: OP_RET_K,
    jt: 0,
    jf: 0,
    k: SECCOMP_RET_ERRNO_ENOSYS,
    label: DENY,
  });
  prog.push({ code: OP_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW, label: ALLOW });

  const labels = new Map<string, number>();
  prog.forEach((ins, i) => {
    if (ins.label) labels.set(ins.label, i);
  });
  const disp = (op: number | string, from: number): number => {
    const target =
      typeof op === "number" ? from + 1 + op : (labels.get(op) as number);
    return target - (from + 1);
  };
  const buffer = Buffer.alloc(prog.length * 8);
  prog.forEach((ins, i) => {
    let jt = 0;
    let jf = 0;
    let k = 0;
    if (ins.code === OP_JA) {
      k = disp(ins.k, i);
    } else {
      k = ins.k as number;
      jt = disp(ins.jt, i);
      jf = disp(ins.jf, i);
    }
    const offset = i * 8;
    buffer.writeUInt16LE(ins.code, offset);
    buffer.writeUInt8(jt & 0xff, offset + 2);
    buffer.writeUInt8(jf & 0xff, offset + 3);
    buffer.writeUInt32LE(k >>> 0, offset + 4);
  });
  return buffer;
};

describe("buildSeccompFilter shape", () => {
  it("emits 8-byte sock_filter entries and loads arch first", () => {
    const filter = buildSeccompFilter();

    assert.equal(filter.length % 8, 0);
    // First instruction must be LD|W|ABS reading seccomp_data.arch (offset 4).
    assert.equal(filter.readUInt16LE(0), OP_LD_W_ABS);
    assert.equal(filter.readUInt32LE(4), 4);
  });

  it("contains ENOSYS, EPERM deny and ALLOW returns at the default level", () => {
    const filter = buildSeccompFilter();
    const returns = new Set();

    for (let index = 0; index < filter.length / 8; index += 1) {
      const offset = index * 8;
      if (filter.readUInt16LE(offset) === OP_RET_K) {
        returns.add(filter.readUInt32LE(offset + 4));
      }
    }

    assert.ok(returns.has(SECCOMP_RET_ERRNO_ENOSYS));
    assert.ok(returns.has(SECCOMP_RET_ERRNO_EPERM));
    assert.ok(returns.has(SECCOMP_RET_ALLOW));
    assert.equal(SECCOMP_RET_ERRNO_ENOSYS, 0x00050026);
    assert.equal(SECCOMP_RET_ERRNO_EPERM, 0x00050001);
    assert.equal(SECCOMP_RET_ALLOW, 0x7fff0000);
    assert.equal(SECCOMP_RET_LOG, 0x7ffc0000);
  });

  it("is deterministic across builds, levels and modes", () => {
    for (const level of PROTECTION_LEVELS) {
      for (const mode of MODES) {
        assert.equal(
          Buffer.compare(
            buildSeccompFilter(level, mode),
            buildSeccompFilter(level, mode)
          ),
          0
        );
      }
    }
  });

  it("defaults to level medium and mode enforce", () => {
    assert.equal(
      Buffer.compare(buildSeccompFilter(), buildSeccompFilter("medium")),
      0
    );
    assert.equal(
      Buffer.compare(
        buildSeccompFilter(),
        buildSeccompFilter("medium", "enforce")
      ),
      0
    );
  });
});

describe("buildSeccompFilter behavior (default/medium level, enforce)", () => {
  const filter = buildSeccompFilter();

  it("blocks a known x86_64 syscall (keyctl) with ENOSYS", () => {
    assert.equal(
      runFilter(filter, {
        nr: BLOCKED_SYSCALLS.keyctl.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ERRNO_ENOSYS
    );
    assert.equal(
      runFilter(filter, {
        nr: BLOCKED_SYSCALLS.bpf.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ERRNO_ENOSYS
    );
  });

  it("allows an unlisted x86_64 syscall (read = 0)", () => {
    assert.equal(
      runFilter(filter, { nr: 0, arch: AUDIT_ARCH_X86_64 }),
      SECCOMP_RET_ALLOW
    );
  });

  it("blocks a known i386 syscall (keyctl) with ENOSYS", () => {
    assert.equal(
      runFilter(filter, {
        nr: BLOCKED_SYSCALLS.keyctl.i386,
        arch: AUDIT_ARCH_I386,
      }),
      SECCOMP_RET_ERRNO_ENOSYS
    );
  });

  it("allows an unlisted i386 syscall (read = 3)", () => {
    assert.equal(
      runFilter(filter, { nr: 3, arch: AUDIT_ARCH_I386 }),
      SECCOMP_RET_ALLOW
    );
  });

  it("does not block on i386 a syscall that is x86_64-only (kexec_file_load)", () => {
    // kexec_file_load has no i386 number; the x86_64 number (320) maps to an
    // unrelated i386 syscall and must NOT be denied under the i386 block.
    assert.equal(BLOCKED_SYSCALLS.kexec_file_load.i386, null);
    assert.equal(
      runFilter(filter, {
        nr: BLOCKED_SYSCALLS.kexec_file_load.x86_64,
        arch: AUDIT_ARCH_I386,
      }),
      SECCOMP_RET_ALLOW
    );
  });

  it("does not filter an unknown arch (conservative ALLOW)", () => {
    const AUDIT_ARCH_AARCH64 = 0xc00000b7;
    assert.equal(
      runFilter(filter, {
        nr: BLOCKED_SYSCALLS.keyctl.x86_64,
        arch: AUDIT_ARCH_AARCH64,
      }),
      SECCOMP_RET_ALLOW
    );
  });
});

describe("protection levels", () => {
  it("level low is byte-identical to the pre-levels Tier-A filter", () => {
    assert.equal(
      Buffer.compare(buildSeccompFilter("low"), buildLegacyLowFilter()),
      0
    );
  });

  it("levels are cumulative and add exactly the decided syscalls", () => {
    const low = new Set(blockedSyscallNamesForLevel("low"));
    const medium = new Set(blockedSyscallNamesForLevel("medium"));
    const high = new Set(blockedSyscallNamesForLevel("high"));

    // low == the Tier-A set (every entry with no explicit level tag).
    assert.deepEqual([...low].sort(), [...TIER_A_NAMES].sort());
    // medium adds exactly its 10 entries over low.
    assert.deepEqual(
      [...medium].filter((n) => !low.has(n)).sort(),
      [...MEDIUM_ADDS].sort()
    );
    // high adds exactly its entries over medium.
    assert.deepEqual(
      [...high].filter((n) => !medium.has(n)).sort(),
      [...HIGH_ADDS].sort()
    );
    // Subset chain low ⊂ medium ⊂ high.
    assert.ok([...low].every((n) => medium.has(n)));
    assert.ok([...medium].every((n) => high.has(n)));
  });

  it("classifies each entry's errno per the Tier-B decision", () => {
    const eperm = [
      "mbind",
      "move_pages",
      "migrate_pages",
      "get_mempolicy",
      "set_mempolicy",
      "userfaultfd",
      "perf_event_open",
    ];
    for (const name of eperm) {
      assert.equal(BLOCKED_SYSCALLS[name].errno, EPERM, `${name} should be EPERM`);
    }
    for (const name of ["io_uring_setup", "io_uring_enter", "io_uring_register"]) {
      assert.equal(BLOCKED_SYSCALLS[name].errno ?? ENOSYS, ENOSYS);
    }
    // Pre-existing Tier-A entries stay bare (default ENOSYS, no level tag).
    for (const name of ["keyctl", "bpf", "init_module", "swapon"]) {
      assert.equal(BLOCKED_SYSCALLS[name].errno, undefined);
      assert.equal(BLOCKED_SYSCALLS[name].level, undefined);
    }
  });

  // For every entry and every level, the compiled filter must deny exactly the
  // entries included at that level (with the right errno) and allow the rest.
  // personality is argument-filtered, covered in its own test.
  it("blocks exactly the included entries per level, with correct errno", () => {
    for (const level of PROTECTION_LEVELS) {
      const filter = buildSeccompFilter(level);
      for (const entry of entriesOf()) {
        if (entry.argFilter) continue;
        const included = includedAt(level, entry);
        const wanted = included ? expectedErrnoAction(entry) : SECCOMP_RET_ALLOW;
        assert.equal(
          runFilter(filter, { nr: entry.x86_64, arch: AUDIT_ARCH_X86_64 }),
          wanted,
          `${entry.name} x86_64 at level ${level}`
        );
        if (entry.i386 !== null) {
          assert.equal(
            runFilter(filter, { nr: entry.i386, arch: AUDIT_ARCH_I386 }),
            wanted,
            `${entry.name} i386 at level ${level}`
          );
        }
      }
    }
  });

  it("only blocks Tier-B entries at their level, not below", () => {
    const low = buildSeccompFilter("low");
    const medium = buildSeccompFilter("medium");
    // io_uring is medium-and-up: allowed at low, ENOSYS at medium.
    assert.equal(
      runFilter(low, {
        nr: BLOCKED_SYSCALLS.io_uring_setup.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ALLOW
    );
    assert.equal(
      runFilter(medium, {
        nr: BLOCKED_SYSCALLS.io_uring_setup.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ERRNO_ENOSYS
    );
    // ptrace is high-only: allowed at medium, EPERM at high.
    assert.equal(
      runFilter(medium, {
        nr: BLOCKED_SYSCALLS.ptrace.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ALLOW
    );
    assert.equal(
      runFilter(buildSeccompFilter("high"), {
        nr: BLOCKED_SYSCALLS.ptrace.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_ERRNO_EPERM
    );
  });
});

describe("personality argument filter (high level)", () => {
  const highEnforce = buildSeccompFilter("high", "enforce");
  const highAudit = buildSeccompFilter("high", "audit");
  const p = BLOCKED_SYSCALLS.personality;
  const cases = [
    { arch: AUDIT_ARCH_X86_64, nr: p.x86_64 },
    { arch: AUDIT_ARCH_I386, nr: p.i386 },
  ];

  it("allows benign personas (PER_LINUX, ADDR_NO_RANDOMIZE, query)", () => {
    for (const { arch, nr } of cases) {
      assert.equal(
        runFilter(highEnforce, { nr, arch, arg0Low: 0x0, arg0High: 0 }),
        SECCOMP_RET_ALLOW,
        "PER_LINUX"
      );
      assert.equal(
        runFilter(highEnforce, { nr, arch, arg0Low: 0x40000, arg0High: 0 }),
        SECCOMP_RET_ALLOW,
        "ADDR_NO_RANDOMIZE"
      );
      // Query is allowed regardless of the args[0] high word.
      assert.equal(
        runFilter(highEnforce, { nr, arch, arg0Low: 0xffffffff, arg0High: 0 }),
        SECCOMP_RET_ALLOW,
        "query high=0"
      );
      assert.equal(
        runFilter(highEnforce, {
          nr,
          arch,
          arg0Low: 0xffffffff,
          arg0High: 0xffffffff,
        }),
        SECCOMP_RET_ALLOW,
        "query high=ffffffff"
      );
    }
  });

  it("EPERMs any other persona, and benign-low with a nonzero high word", () => {
    for (const { arch, nr } of cases) {
      // PER_BSD (0x6) — not in the allowed set.
      assert.equal(
        runFilter(highEnforce, { nr, arch, arg0Low: 0x6, arg0High: 0 }),
        SECCOMP_RET_ERRNO_EPERM
      );
      // PER_LINUX low but a real 64-bit value (high != 0) must be rejected.
      assert.equal(
        runFilter(highEnforce, { nr, arch, arg0Low: 0x0, arg0High: 1 }),
        SECCOMP_RET_ERRNO_EPERM
      );
    }
  });

  it("in audit mode logs the rejected persona but still ALLOWs benign ones", () => {
    assert.equal(
      runFilter(highAudit, {
        nr: p.x86_64,
        arch: AUDIT_ARCH_X86_64,
        arg0Low: 0x6,
        arg0High: 0,
      }),
      SECCOMP_RET_LOG
    );
    assert.equal(
      runFilter(highAudit, {
        nr: p.x86_64,
        arch: AUDIT_ARCH_X86_64,
        arg0Low: 0x0,
        arg0High: 0,
      }),
      SECCOMP_RET_ALLOW
    );
  });
});

describe("audit mode", () => {
  it("differs from enforce ONLY in the deny return constants", () => {
    for (const level of PROTECTION_LEVELS) {
      const enforce = decode(buildSeccompFilter(level, "enforce"));
      const audit = decode(buildSeccompFilter(level, "audit"));
      assert.equal(audit.length, enforce.length, `length at ${level}`);
      for (let i = 0; i < enforce.length; i += 1) {
        const e = enforce[i];
        const a = audit[i];
        // Opcode and jump displacements are identical in both modes.
        assert.equal(a.code, e.code, `code[${i}] at ${level}`);
        assert.equal(a.jt, e.jt, `jt[${i}] at ${level}`);
        assert.equal(a.jf, e.jf, `jf[${i}] at ${level}`);
        if (e.code === OP_RET_K && e.k !== SECCOMP_RET_ALLOW) {
          // Deny slot: enforce carries an errno, audit carries RET_LOG.
          assert.ok(
            e.k === SECCOMP_RET_ERRNO_ENOSYS || e.k === SECCOMP_RET_ERRNO_EPERM,
            `enforce deny slot[${i}]`
          );
          assert.equal(a.k, SECCOMP_RET_LOG, `audit deny slot[${i}]`);
        } else {
          // Everything else (incl. the ALLOW return) is byte-identical.
          assert.equal(a.k, e.k, `k[${i}] at ${level}`);
        }
      }
    }
  });

  it("logs instead of erroring for medium-level entries", () => {
    const auditMedium = buildSeccompFilter("medium", "audit");
    assert.equal(
      runFilter(auditMedium, {
        nr: BLOCKED_SYSCALLS.perf_event_open.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_LOG
    );
    assert.equal(
      runFilter(auditMedium, {
        nr: BLOCKED_SYSCALLS.io_uring_setup.x86_64,
        arch: AUDIT_ARCH_X86_64,
      }),
      SECCOMP_RET_LOG
    );
    // Unlisted syscalls are still plainly allowed (not logged).
    assert.equal(
      runFilter(auditMedium, { nr: 0, arch: AUDIT_ARCH_X86_64 }),
      SECCOMP_RET_ALLOW
    );
  });
});

// Cross-check every embedded number against the host uapi headers so a wrong
// number is caught wherever the headers ship. Covers ALL entries of all levels.
// Skipped on hosts without them.
describe("BLOCKED_SYSCALLS host-header cross-check", () => {
  const headersPresent = fs.existsSync(UNISTD_64) && fs.existsSync(UNISTD_32);

  it(
    "matches /usr/include/asm/unistd_{64,32}.h",
    { skip: headersPresent ? false : "uapi headers not present" },
    () => {
      const x86_64 = parseUnistd(UNISTD_64);
      const i386 = parseUnistd(UNISTD_32);

      for (const [name, numbers] of Object.entries(BLOCKED_SYSCALLS)) {
        assert.equal(
          x86_64.get(name),
          numbers.x86_64,
          `x86_64 __NR_${name} mismatch (header ${x86_64.get(name)} vs embedded ${numbers.x86_64})`
        );

        if (numbers.i386 === null) {
          assert.equal(
            i386.has(name),
            false,
            `expected no i386 __NR_${name} but header defines ${i386.get(name)}`
          );
        } else {
          assert.equal(
            i386.get(name),
            numbers.i386,
            `i386 __NR_${name} mismatch (header ${i386.get(name)} vs embedded ${numbers.i386})`
          );
        }
      }
    }
  );
});

// The pure effective-level resolution that sandbox-launch.ts drives: per-game
// override wins over the global preference (both directions), "off" and the
// global kill-switch disable the filter, and the diagnostic flag selects audit
// mode whenever a filter is attached.
describe("resolveSeccomp", () => {
  it("defaults to enabled at medium/enforce when nothing is configured", () => {
    assert.deepEqual(resolveSeccomp(null, null), {
      enabled: true,
      level: "medium",
      mode: "enforce",
      source: "global",
    });
  });

  it("uses the global level when set and no per-game override exists", () => {
    assert.deepEqual(resolveSeccomp({ seccompLevel: "high" }, null), {
      enabled: true,
      level: "high",
      mode: "enforce",
      source: "global",
    });
  });

  it("disables the filter when the global kill-switch is set", () => {
    const resolution = resolveSeccomp({ disableSeccomp: true }, null);
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "global");
  });

  it("lets a per-game level win over the global level", () => {
    assert.deepEqual(
      resolveSeccomp({ seccompLevel: "medium" }, { seccompLevel: "high" }),
      { enabled: true, level: "high", mode: "enforce", source: "game" }
    );
  });

  it("lets a per-game level re-enable over the global kill-switch", () => {
    assert.deepEqual(
      resolveSeccomp({ disableSeccomp: true }, { seccompLevel: "low" }),
      { enabled: true, level: "low", mode: "enforce", source: "game" }
    );
  });

  it("disables the filter for a per-game 'off' even when global is on", () => {
    const resolution = resolveSeccomp(
      { disableSeccomp: false, seccompLevel: "high" },
      { seccompLevel: "off" }
    );
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.source, "game");
  });

  it("selects audit mode from the per-game diagnostic flag", () => {
    assert.equal(resolveSeccomp(null, { seccompAudit: true }).mode, "audit");

    const overridden = resolveSeccomp(
      { seccompLevel: "high" },
      { seccompLevel: "low", seccompAudit: true }
    );
    assert.equal(overridden.mode, "audit");
    assert.equal(overridden.level, "low");
  });

  it("keeps the resolved mode/level reportable even when disabled", () => {
    const resolution = resolveSeccomp(
      { disableSeccomp: true, seccompLevel: "high" },
      { seccompAudit: true }
    );
    assert.equal(resolution.enabled, false);
    assert.equal(resolution.mode, "audit");
    assert.equal(resolution.level, "high");
  });
});
