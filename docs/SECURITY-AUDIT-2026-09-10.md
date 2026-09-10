# Game sandbox security review — 2026-09-10

For the subsequent fixes, verification and remaining limits, see
[the hardening implementation](SECURITY-HARDENING.md). The findings below are
the original observations, preserved for comparison.

Reviewed Hydra `d8705a537` (4.1.3) and sandbox-probe `e80e33f`.

**Verdict:** useful containment, but not sufficient yet for the stated threat
model of deliberately hostile game executables. The normal path isolates the
home, process namespace, IPC and host loopback in the checks performed. Failure
paths and shared writable resources weaken that boundary substantially.

This review covers native games, Wine/Proton, installers, launch routing,
filesystem mounts, environment, seccomp, networking and adjacent save handling.
Classics and RetroArch emulators are intentionally exempt; their unsandboxed
launches are not findings. This commit adds audit tooling and documentation,
not production fixes. No release or push is included.

## Reproduced findings

### 1. High: failed network setup executes the game on the host network with setup capabilities

Location: `src/main/services/sandbox-command-builder.ts:42`.

The wrapper's `_fail_open()` executes the payload directly. It neither refuses
the launch nor passes through the capability drop used on the successful path.
Using `/usr/bin/false` as the pasta executable deterministically exercises a
setup failure without modifying any installed tool.

Observed with the actual production profile and medium/enforce seccomp:

| Property                                             | Working pasta | Failed pasta |
| ---------------------------------------------------- | ------------- | ------------ |
| Game network namespace differs from host             | Yes           | No           |
| Harness service on host `127.0.0.1` reachable        | No            | Yes          |
| Effective/permitted/inheritable/ambient capabilities | Zero          | `0x201000`   |
| `no_new_privs`                                       | 1             | 1            |
| `bpf` and `keyctl` denied by seccomp                 | Yes           | Yes          |

`0x201000` is `CAP_SYS_ADMIN | CAP_NET_ADMIN`. These are capabilities in the
bwrap user namespace, **not root capabilities in the host user namespace**.
An attempted writable remount of a disposable read-only bind still failed on
this host. This review does not claim a demonstrated host-root or arbitrary
filesystem escape. It does demonstrate loss of network isolation and retention
of privileges that must never reach a game.

Missing pasta also silently degrades to the host network in
`src/main/helpers/sandbox-launch.ts:260`. This second path does not add the
setup capabilities, but still contradicts the enabled isolation preference.

Recommendation: fail closed whenever requested network isolation cannot be
established; return an actionable launch error. Keep explicit per-game/global
opt-outs. Verify the namespace identity and drop capability sets before every
payload execution. The readiness check at builder line 57 only checks whether
`/proc/<pid>/ns/net` exists; that path can exist before `unshare()` completes.
Replace it with a bounded positive namespace-ready handshake. That race is a
source-level concern, not separately reproduced here.

### 2. High: every game can modify the shared UMU runtime

Location: `src/main/services/sandbox-command-builder.ts:520`.

`~/.local/share/umu` is automatically mounted read-write for every game,
including native launches. A synthetic file in that directory could be opened
for writing from all three audited profiles. This crosses the intended
per-game state boundary: a malicious game can damage or poison shared runtime
content subsequently consumed by another launch or another UMU consumer.

The write access is reproduced; subsequent execution of a poisoned runtime
outside Hydra's sandbox is **not** demonstrated. In particular, Hydra sets
`UMU_NO_RUNTIME=1` for sandboxed executable launches. The unsandboxed
`Umu.preparePrefix()` path deserves review before enabling account/cloud
features, but its automatic pre-launch caller is auth/subscription-gated in
this accountless configuration.

Recommendation: remove this mount from native games and from launches that do
not need it. Provision verified runtime versions through a trusted updater and
mount them read-only; put mutable locks, caches and game state in separate
per-game directories. Do not solve updater failures by exposing executable
runtime content read-write again.

### 3. Medium: x32 syscalls bypass the compiled seccomp blocklist

Location: `src/main/services/sandbox-seccomp.ts:524`.

The x86_64 dispatch compares only the ordinary syscall numbers. Interpreting
the generated production BPF gives:

```
arch=x86_64, nr=321               -> ERRNO(ENOSYS)
arch=x86_64, nr=0x40000000 | 321  -> ALLOW
```

x32 shares the x86_64 audit architecture and distinguishes its calls using
`__X32_SYSCALL_BIT`. The host kernel configuration has
`CONFIG_X86_X32_ABI` disabled, so this is a proven filter-policy hole, **not an
exploitable x32 syscall path demonstrated on this Fedora host**. Unknown audit
architectures are also explicitly allowed by the current filter and tests.

Recommendation: deny unsupported architectures and x32 syscall encodings before
dispatching to the supported x86_64/i386 tables. Cover the encodings in every
level and the intended audit-mode semantics. Native Wine i386 support must
remain intact. The distinction is documented in the
[Linux seccomp manual](https://man7.org/linux/man-pages/man2/seccomp.2.html).

### 4. Medium: trusted-tool resolution actually trusts arbitrary PATH precedence

Locations: `src/main/helpers/resolve-system-binary.ts:21` and
`src/main/services/sandbox-network.ts:82`.

Placing harmless executable fixtures named `umu-run` and `pasta` before
`/usr/bin` in PATH makes both resolvers select those fixtures. The fixtures
were only resolved, never executed. `resolveSystemBinary()` also does not move
`~/.local/bin` to the end if it is already present early in PATH.

This is conditional on an untrusted or game-writable directory entering the
launcher's PATH; a game cannot freely change its parent's environment. The
implementation nevertheless does not enforce the trusted-directory policy
described in AGENTS.md. Host-side consumers such as backup tools make that
distinction significant.

Recommendation: use an explicit ordered list of trusted absolute directories,
validate the resolved file and its ancestry, and make any user-owned fallback
an explicit, last-resort trust decision. Apply the same resolver to pasta and
other wrappers instead of retaining separate PATH scans.

## Additional source-level findings and exposure

### High priority: desktop and input access exceeds what hostile games should receive

Locations: `sandbox-command-builder.ts:443`, `:447`, `:535` and
`listRuntimeSockets()` in the same file.

The profile exposes all `/dev/input` and `hidraw*` nodes present, not only game
controllers. Host device permissions/ACLs still apply, so exposure does not
prove that every keyboard is readable. The profile does not itself enforce
controller-only access. It also shares the host PulseAudio/PipeWire sockets.
A read-only bind of a Unix socket does not restrict the operations available
through its protocol.

Host X11 sockets and authentication are exposed whenever `hideX11` is false.
Normal game launchers only hide them when using nested gamescope on Wayland;
the installer path does not request this. On X11 this grants the capabilities
of an ordinary client of the shared server; under XWayland the affected scope
is the shared X server, not automatically every native Wayland window.

Recommendation: require a private game display boundary for the strict profile,
select controller devices using udev properties, and broker audio with explicit
playback/capture policy. Treat the GPU driver/compositor/audio server as part
of the remaining attack surface. No keyboard capture, microphone recording or
desktop injection was attempted in this review.

### High priority: review host-side save restore as an untrusted-input boundary

Location: `src/main/services/cloud-sync.ts:545` through `:597`.

The active legacy/local restore path reads `mapping.yaml`, rewrites path
strings, then uses host-side `mkdirSync`, `unlinkSync` and `renameSync`.
It does not enforce that the resulting source stays under the scratch
directory or that the destination remains within approved save roots after
resolving parent symlinks. Safe tar extraction alone does not enforce this
second-stage restore policy.

A malicious shared backup can supply destination paths; game-writable prefix
directories can contain attacker-controlled parent symlinks. This code therefore
needs canonical containment and symlink/race defenses before claiming that
filesystem isolation also survives backup/restore. An end-to-end malicious
backup restore was not run against the user's saves.

Recommendation: validate artifact schemas and identifiers, bound source and
destination roots, and perform writes through directory descriptors with
no-follow/beneath resolution. Run the save worker with access restricted to
the game's approved state and artifact scratch space. Cover malicious mapping
paths and parent-directory symlinks using disposable fixtures.

### Close the remaining installer fallback to the desktop handler

Location: `src/main/events/library/open-game-installer.ts:159`.

After UMU fails and the Wine launcher returns false, Linux falls through to
`shell.openPath(filePath)`. That can invoke the desktop's `.exe` association
outside the sandbox. This is a narrow error path: ordinary bwrap child exits
are not spawn errors, and missing-bwrap guards usually throw earlier. A spawn
failure after the availability check can still reach it. It is not an
emulator exemption and should never be a fallback for a sandbox-required
installer. The desktop handler was not invoked during this audit.

### Requested seccomp can disappear on a filter-write error

Location: `src/main/helpers/sandbox-launch.ts:207`.

Failure to write the compiled filter returns `undefined` and launches without
seccomp. The separate filter-open failure normally causes bwrap to fail, which
is preferable. Apply that fail-closed behavior to construction/storage failures
too, and make the effective state visible in the UI. The diagnostic audit mode
intentionally allows blocked calls; do not present it as enforcing protection.

### Network isolation is not an outbound firewall or anonymity proxy

Working pasta blocks the host-loopback test and disables port forwarding, but
the design deliberately retains Internet and LAN access. It does not prevent
exfiltration of data that a game can read, or attacks against reachable LAN
services. Add a game-only outbound policy if those are in scope, preserving
only the intended DNS-forwarding exception. Emulator networking can remain
unchanged under the owner's exemption.

### Broad mounts and resource exhaustion remain relevant

The game directory, prefix and extra paths are accepted without a policy
against mounting the real home, launcher state or a shared library root.
Launching an executable directly from such a directory expands access to that
directory. Bind validation should consider canonical paths and overlapping
roots, not only lexical path names.

Whole `/etc` and `/sys` mounts expose host-readable configuration and hardware
metadata. A fake machine-id is not general anti-fingerprinting. Narrow these
mounts where practical. PID/cgroup namespaces do not impose process, memory or
disk quotas: add actual resource limits for fork bombs and space exhaustion.
These destructive tests were intentionally not performed.

## Positive results and coverage limits

- UI/tray/deep-link routes inspected converge on `launchGame`; native and
  Wine/UMU game execution passes through `wrapWithSandbox`. Linux shortcuts
  target Hydra and its run deep link. The installer fallback above is separate.
- The basic external Rust probe passed **9/9**, including the host-side
  `/dev/shm` marker check. It was cloned into `../hydra-sandbox-probe` and built
  from its locked dependency set. The external probe source was not modified.
- The supplemental audit produced **22 passes and 9 failures across 31
  assertions**. Several failures describe the same weakness in different
  scenarios; these are not nine distinct vulnerabilities. Exit status 1 is
  intentional until the security invariants are fixed.
- The successful pasta case had a distinct network namespace, blocked the live
  host-loopback canary and had zero effective/permitted/inheritable/ambient
  capabilities. Medium seccomp denied the two safe invalid syscall probes.
- No test demonstrated arbitrary host code execution, a kernel exploit or
  compromise of another real game. Full Wine/Proton/gamescope gameplay and
  Steam Deck hardware were not exercised.

The existing `sandbox:selftest` uses the real builder, but omits the seccomp
fd, network-isolation options, machine-id and environment scrub. Its nine
passes establish only that baseline profile. Its home-content heuristic can
also misclassify a nonempty persistent home on a non-tmpfs filesystem.

The supplemental audit uses the production builder, environment scrubber,
network DNS helpers, syscall filter and binary resolvers. It uses a synthetic
home/runtime, omits desktop sockets, and drives the builder directly rather
than booting Electron or calling `wrapWithSandbox`. It therefore tests the
identified boundaries without claiming complete production launch parity.
Only disposable files under `/tmp` and a temporary loopback server are used;
no real runtime contents are overwritten and no payload is sent to another
machine. The baseline Rust probe separately tests outbound Internet access.

## Reproduction

From the Hydra checkout, on Linux x86_64 with bwrap, pasta and Python 3:

```sh
node --import ./scripts/register-ts-node.mjs scripts/sandbox-security-audit.mjs
```

The supplemental audit needs permission to create namespaces and a loopback
listener. Exit 0 means all checked invariants held, 1 means a security assertion
failed, and 2 means the audit could not complete. Fault injection substitutes
`/usr/bin/false` for pasta only in the generated test invocation.

The original probe can also be run independently:

```sh
cargo build --release --locked --manifest-path ../hydra-sandbox-probe/Cargo.toml
npx yarn sandbox:selftest
```

Tested host: Linux `7.1.13-200.fc44.x86_64`, bubblewrap `0.12.0`, pasta
`0^20260728.gf8df3f1-2.fc44.x86_64`. Runtime-specific findings should be repeated
on SteamOS; do not infer Deck compatibility from this host.

Repository validation: typecheck passed; lint completed with zero errors and
79 existing warnings. Its unrelated formatting change in `cloud-sync.ts` was
reverted. The application suite passed **644/644 tests** using the system Node
22 via `PATH=/usr/bin:/bin npx yarn test`, matching CI's Node major version.
The first run with the default Homebrew Node 26.8.1 aborted two test files in
V8 with `Fatal error: unreachable code`; these were runtime crashes rather
than failed application assertions. No application source was changed to make
the tests pass.

Bubblewrap's own [security model and limitations](https://raw.githubusercontent.com/containers/bubblewrap/main/README.md)
explain why protection depends on the caller's mount/socket policy. Linux
[user namespace documentation](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
explains the scope of the leaked capabilities; they must not be confused with
host-root privileges.

## Suggested order of remediation

1. Fail closed for requested network/seccomp protection, eliminate the installer
   desktop fallback, and positively verify network setup before execution.
2. Remove shared writable executable runtimes and enforce trusted tool paths.
3. Constrain restore paths and symlinks; limit device, audio and display access.
4. Close x32/unsupported-architecture holes and add CI policy checks plus this
   manual integration audit. Verify nested Proton/gamescope behavior on real
   Fedora and Deck hardware before shipping.
5. Add optional outbound restrictions and enforce resource quotas according to
   the desired game threat model.
