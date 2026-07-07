import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  AUDIT_ARCH_I386,
  AUDIT_ARCH_X86_64,
  BLOCKED_SYSCALLS,
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO_ENOSYS,
  buildSeccompFilter,
} from "./sandbox-seccomp.ts";

const UNISTD_64 = "/usr/include/asm/unistd_64.h";
const UNISTD_32 = "/usr/include/asm/unistd_32.h";

// A tiny classic-BPF interpreter covering exactly the opcodes buildSeccompFilter
// emits: LD|W|ABS, JMP|JEQ|K, JMP|JA, RET|K. It reads the two seccomp_data
// fields the filter uses (nr at offset 0, arch at offset 4) from `data`.
const OP_LD_W_ABS = 0x20;
const OP_JEQ_K = 0x15;
const OP_JA = 0x05;
const OP_RET_K = 0x06;

const runFilter = (
  filter: Buffer,
  data: { nr: number; arch: number }
): number => {
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

const parseUnistd = (file: string): Map<string, number> => {
  const map = new Map<string, number>();
  const content = fs.readFileSync(file, "utf8");
  const pattern = /^#define\s+__NR_(\w+)\s+(\d+)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    map.set(match[1], Number(match[2]));
  }
  return map;
};

describe("buildSeccompFilter shape", () => {
  it("emits 8-byte sock_filter entries and loads arch first", () => {
    const filter = buildSeccompFilter();

    assert.equal(filter.length % 8, 0);
    // First instruction must be LD|W|ABS reading seccomp_data.arch (offset 4).
    assert.equal(filter.readUInt16LE(0), OP_LD_W_ABS);
    assert.equal(filter.readUInt32LE(4), 4);
  });

  it("contains the ENOSYS deny and ALLOW return actions", () => {
    const filter = buildSeccompFilter();
    const returns = new Set<number>();

    for (let index = 0; index < filter.length / 8; index += 1) {
      const offset = index * 8;
      if (filter.readUInt16LE(offset) === OP_RET_K) {
        returns.add(filter.readUInt32LE(offset + 4));
      }
    }

    assert.ok(returns.has(SECCOMP_RET_ERRNO_ENOSYS));
    assert.ok(returns.has(SECCOMP_RET_ALLOW));
    assert.equal(SECCOMP_RET_ERRNO_ENOSYS, 0x00050026);
    assert.equal(SECCOMP_RET_ALLOW, 0x7fff0000);
  });

  it("is deterministic across builds", () => {
    assert.equal(Buffer.compare(buildSeccompFilter(), buildSeccompFilter()), 0);
  });
});

describe("buildSeccompFilter behavior", () => {
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
        nr: BLOCKED_SYSCALLS.keyctl.i386 as number,
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

// Cross-check the embedded numbers against the host uapi headers so a wrong
// number is caught wherever the headers ship. Skipped on hosts without them.
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
