# Fork maintenance guide

## What this fork is

This is a personal, Linux-only fork of [hydralauncher/hydra](https://github.com/hydralauncher/hydra).
It tracks upstream closely and is intended to stay mergeable with it. Upstream remains the
source of truth for features and dependency updates; this fork only layers Linux-focused
changes (sandboxing, local saves/achievements, de-accounting) on top.

## Divergence principles

To keep merges cheap, divergence follows a few rules:

- **New behavior lives in new files.** Prefer adding modules over editing existing ones.
- **Surgical edits at choke points.** When an existing file must change, touch the smallest
  possible span (a single import, a single call site) rather than refactoring around it.
- **Platform code stays in place.** `win32` / `darwin` branches are left untouched as dead
  code. Do not delete or reformat them — that only creates merge conflicts.
- **Account features are gated, not deleted.** Hydra-account-gated functionality is disabled
  behind a flag/guard; anonymous API calls stay. Deleting the code path would diverge harder
  than gating it.
- **Hard deletions are limited to CI workflows and binary blobs.** These are the only things
  removed outright, since they never merge cleanly and carry no runtime value for the fork
  (e.g. telemetry, upstream-only build/signing config).
- **No reformatting, no unrelated cleanup.** Keep diffs minimal so `git merge` can auto-resolve.

## Update procedure

```bash
git fetch upstream
git merge upstream/main
```

The `upstream` remote is `https://github.com/hydralauncher/hydra.git`. Add it once if missing:

```bash
git remote add upstream https://github.com/hydralauncher/hydra.git
```

### Expected conflict hotspots

- **`package.json`** — take upstream's dependency bumps and version; keep any fork-only
  script/dependency removals (e.g. removed telemetry packages). Re-run `yarn install`
  afterwards to regenerate `yarn.lock`.
- **`.github/workflows/*`** — keep the fork's CI. Upstream's signing/telemetry/publish steps
  are intentionally removed here; do not reintroduce them when resolving.
- **`electron-builder.yml`** — keep the fork's packaging config (Linux targets, no upstream
  code signing / auto-update endpoints).

### After merging

```bash
yarn install     # only if dependencies changed
yarn typecheck
yarn lint
```

Resolve conflicts favoring **upstream for product code and dependencies**, and **the fork for
CI, packaging, and platform-gating**. Commit the merge only once typecheck and lint are green.

## Environment configuration

The fork commits a working `.env` (force-added past `.gitignore`) so `yarn dev`
and `yarn build` work out of the box. All values are **public endpoints, not
secrets**:

- `MAIN_VITE_API_URL=https://hydra-api-us-east-1.losbroxas.org` — the anonymous
  Hydra API (catalogue, download sources, achievements), used without any auth
  header in accountless mode.
- `MAIN_VITE_EXTERNAL_RESOURCES_URL` / `RENDERER_VITE_EXTERNAL_RESOURCES_URL=https://assets.hydralauncher.gg`
  — public CDN serving `game-executables.json` and the `steam-*.json`
  catalogue filter data. The remote `bundle.js` (support-chat widget) is NOT
  loaded by this fork.

Account/login-only vars (`MAIN_VITE_AUTH_URL`, `MAIN_VITE_WS_URL`,
`MAIN_VITE_CHECKOUT_URL`, `MAIN_VITE_LAUNCHER_SUBDOMAIN`) are unused in
accountless mode and left empty; their consumers are guarded to degrade
gracefully rather than crash. `MAIN_VITE_NIMBUS_API_URL` (VikingFile hoster
unlock) has no public endpoint wired here, so that single feature throws a clear
error if used; everything else works. Env reads that previously assumed a value
(`isStaging`, the cloud-iframe URL) are now null-safe, so a missing `.env` no
longer hard-crashes boot.

## Sandbox selftest

The game sandbox (bubblewrap) ships with an adversarial verifier that runs the
real profile end-to-end. It lives in the sibling repo
[`hydra-sandbox-probe`](https://github.com/CappyT/hydra-sandbox-probe) and is
driven by `yarn sandbox:selftest`, which builds the exact bwrap profile the app
uses for real games (via the unmodified `buildSandboxArgs`) and runs the probe
inside it, so there is zero drift between what is tested and what ships.

```bash
# 1. build the probe once (sibling checkout, next to this repo)
cd ../hydra-sandbox-probe && cargo build --release && cd -

# 2. run the selftest against the real profile
yarn sandbox:selftest
```

Every check must report `PASS` and the runner must exit 0. Point
`SANDBOX_PROBE_BIN` at a prebuilt binary to skip the local cargo build. This is
a manual, Linux-only check and is intentionally kept out of CI.

## Seccomp syscall filter

On top of the bwrap sandbox, sandboxed launches install a seccomp classic-BPF
filter (`--seccomp <fd>`) built in pure Node by `src/main/services/sandbox-seccomp.ts`
(no native addon, deterministic, unit-decodable). It is a **blocklist with a
default-ALLOW**: only a small set of kernel-LPE / sandbox-escape syscalls are
turned into an errno (`ENOSYS` so a probing game degrades, or `EPERM` where a
permission-denied is the honest failure); everything else — including the
namespace/mount/prctl/seccomp calls the nested pressure-vessel and wine need —
is allowed automatically. A write failure is fail-open (the game launches
without the filter): seccomp is a hardening layer, not the sandbox boundary.

### Protection levels (cumulative, low ⊂ medium ⊂ high)

Set globally in **Settings → Compatibility** (default **medium**) and overridable
per game in the game options modal (`follow global / off / low / medium / high`).
A per-game level wins over the global level **and** over the global kill-switch;
per-game `off` disables the filter for that game only.

- **low** — Tier-A kernel-LPE / escape primitives only, all `ENOSYS`:
  `add_key` `request_key` `keyctl`, `bpf`, `kexec_load` `kexec_file_load`,
  `init_module` `finit_module` `delete_module`, `iopl` `ioperm`,
  `swapon` `swapoff`, `acct`, `quotactl`, `reboot`, `syslog`,
  `settimeofday` `clock_settime` `clock_adjtime` `adjtimex`,
  `open_by_handle_at`, the new mount API (`open_tree` `move_mount` `fsopen`
  `fsconfig` `fsmount`), and legacy admin calls (`uselib` `ustat` `nfsservctl`
  `_sysctl`).
- **medium** (default) — low **plus** the NUMA memory-policy family
  (`mbind` `set_mempolicy` `get_mempolicy` `migrate_pages` `move_pages`, `EPERM`),
  `userfaultfd` (`EPERM`), `perf_event_open` (`EPERM`) and the io_uring trio
  (`io_uring_setup` `io_uring_enter` `io_uring_register`, `ENOSYS`). Mirrors
  flatpak's base filter applied to Steam.
- **high** — medium **plus** calls that may genuinely break some titles:
  `ptrace`, `name_to_handle_at`, `pidfd_getfd`, `process_madvise`,
  `set_mempolicy_home_node` (`EPERM`), `clone3` and `memfd_secret` (`ENOSYS`),
  plus an argument-filtered `personality` (only `PER_LINUX` /
  `ADDR_NO_RANDOMIZE` / the read-only query pass; other personas → `EPERM`).

### Audit / diagnosis flow

A game may break with the filter on. To find the culprit without turning
protection off, enable the **per-game diagnostic** checkbox ("Log blocked
syscalls instead of blocking them"). It rebuilds the filter at the same
effective level but in **audit mode**: every would-be block becomes
`SECCOMP_RET_LOG` (`0x7ffc0000`) — the syscall is **allowed** and logged by the
kernel instead of erroring. Enforcement is suspended for that game while it is
on.

Read the kernel log to see what fired:

```bash
sudo journalctl -k --grep=SECCOMP
```

Each line carries the audit **arch** token (`0xc000003e` = x86_64,
`0x40000003` = i386), the **syscall nr**, and `code=0x7ffc0000` (the RET_LOG
action). Map the nr back to a name with the level tables above (or
`ausyscall <arch> <nr>`), then either drop to a lower level or leave audit off
once the offending call is identified.

## Network isolation (pasta)

When the sandbox is enabled and `pasta` (the `passt` package) is on `PATH`,
sandboxed games run in their own network namespace instead of the host's.
Global toggle in **Settings → Compatibility** (default **on**), per-game
tri-state override in the game options modal (a per-game choice wins over the
global default). If isolation is wanted but `pasta` is missing, the game
launches with the host network and a one-time warning is logged.

Because an unprivileged bwrap cannot hand its netns to a pasta running in the
init user namespace, **pasta runs as the outermost command *inside* bwrap**:
bwrap sets up every other namespace but keeps the host network, then execs
`pasta … -- <game>`. pasta creates a fresh user+net namespace and bridges it to
the host with a userspace tap. All port forwarding is disabled both ways
(`-t none -u none -T none -U none`) and **`--no-map-gw`** is passed so host
loopback services stay unreachable via the gateway IP; internet and LAN still
work through pasta's NAT. DNS is forwarded to the host resolver
(`--dns-forward` / `--dns-host`) via a generated `resolv.conf` bound into the
sandbox. See `src/main/services/sandbox-network.ts`.

### Launch logging

Every sandboxed launch logs one concise line each for both hardening layers
(via the app's `main` logger, `logs.txt`/`info.txt`): the effective seccomp
state — `level/mode (from game|global)` or `disabled` — and the network state —
`isolated (pasta)`, `disabled (pasta unavailable)`, or `disabled`.
