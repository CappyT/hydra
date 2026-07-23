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
- **`electron-builder.yml`** — keep the fork's packaging config. The Linux target is
  **AppImage only** (deb/rpm dropped for build speed — the fork only ships AppImage); no
  upstream code signing / auto-update endpoints.

### CI workflows

The fork's CI is kept lean for fast release turnaround:

- **`build.yml`** — a single build-smoke job on PRs and `main` pushes (the upstream
  second `build-production` job was removed; release artifacts come from `release.yml`).
- **`release.yml`** — triggered by pushing a `release/**` branch; builds the AppImage,
  embeds the standard AppImage update information (`gh-releases-zsync|CappyT|hydra|latest|…`
  written into the `.upd_info` ELF section via `scripts/embed-appimage-update-info.mjs`,
  which also recomputes `latest-linux.yml`'s sha512 for the patched file — this is what
  lets Gear Lever / AppImageUpdate discover updates) and a `.zsync` file, derives the tag
  `v<package.json version>`, and creates a **draft** release with the
  AppImage + `latest-linux.yml` + `.zsync` (all needed for auto-update). Publish the draft
  manually, or via `gh release edit v<version> --draft=false --latest`. Redundant steps
  (rpm tooling, a duplicate Python-RPC build already done by `build:linux`, and the
  duplicate `upload-artifact`) were removed; Python setup + `build:linux` (which builds the
  Python RPC and native addon) are retained.

To cut a release: `git push origin main:release/<version>` (fast-forward), let the workflow
build the draft, then publish it. To replace a bad release, delete the release + tag first
(`gh release delete v<version> --yes`; `git push origin :refs/tags/v<version>`).

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

**Architecture — a single user namespace (podman-rootless style).** The obvious
design (`bwrap --unshare-net` + pasta attaching from the init user namespace)
does NOT work unprivileged: pasta gets EPERM joining bwrap's netns. Running pasta
as the *outermost* command inside bwrap also fails in practice — it creates a
SECOND user namespace (mapping uid 1000→0), and stacking two user namespaces
breaks the *nested* unprivileged user namespaces that gamescope's GTK/glycin
image loaders and Proton's pressure-vessel need (games crash with `code=139`).

The working design keeps ONE user namespace (bwrap's). bwrap is NOT given
`--unshare-net`; it is granted `CAP_NET_ADMIN` + `CAP_SYS_ADMIN` for the setup
phase and its payload is an in-sandbox wrapper
(`NETWORK_ISOLATION_WRAPPER` in `src/main/services/sandbox-command-builder.ts`)
that: (1) opens a fresh netns in bwrap's own userns via an `unshare --net`
placeholder, (2) services it with `pasta --config-net --netns <ns>` in ATTACH
mode (pasta does not exec the game), and (3) runs the game inside that netns with
ALL capabilities dropped (`nsenter` + `setpriv --inh-caps=-all
--ambient-caps=-all`), so the game ends up at `CapEff=0`. All port forwarding is
disabled both ways (`-t/-u/-T/-U none`) and **`--no-map-gw`** is passed so host
loopback services stay unreachable via the gateway IP; internet and LAN still
work through pasta's NAT. DNS is forwarded to the host resolver
(`--dns-forward` / `--dns-host`) via a generated `resolv.conf` bound into the
sandbox. pasta/placeholder die with the sandbox pid namespace (no orphans). The
game itself runs with zero capabilities, so nested user namespaces work and the
posture matches the pre-isolation sandbox. See
`src/main/services/sandbox-network.ts` and the `HYDRA_PASTA_*` env the builder
sets.

### Launch logging

Every sandboxed launch logs one concise line each for both hardening layers
(via the app's `main` logger, `logs.txt`/`info.txt`): the effective seccomp
state — `level/mode (from game|global)` or `disabled` — and the network state —
`isolated (pasta)`, `disabled (pasta unavailable)`, or `disabled`.

## Gamescope integration

When `gamescope` is on `PATH` it wraps launched games (per-game `useGamescope`
tri-state, effectively on when the binary is detected). gamescope in nested mode
defaults its internal render size to 1280×720 and upscales, so without explicit
dimensions every game runs at 720p — and at the wrong aspect ratio on a
non-16:9 monitor. `src/main/helpers/resolve-gamescope-wrapper.ts` sizes it to the
CURRENT display on every launch: `-W/-H` (output) and `-w/-h` (internal render)
are both set to the display's physical resolution (`display.size ×
scaleFactor` from Electron's `screen` API) and `-r` to the refresh rate.

Refresh detection is layered because Electron's `displayFrequency` reports 0 on
GNOME/KDE Wayland: it tries Electron first (correct on X11), then falls back to
parsing `xrandr --current` (the `*`-marked mode, correct on X11 and
XWayland-backed Wayland), then omits `-r` (gamescope's 60 Hz default) as a last
resort. All four gamescope call sites (native, wine, classics, umu) use the
shared `buildGamescopeWrapper()`. Note: some engines self-cap (e.g. Hollow
Knight/Unity is locked to 60 fps regardless of what gamescope advertises).

Inside a gamescope session (SteamOS gaming mode / Steam Deck,
`XDG_CURRENT_DESKTOP=gamescope`) the wrapper is forced OFF, even when the
per-game toggle is explicitly on: the session compositor already owns the
display, and a nested gamescope cannot bring up its embedded Xwayland inside
the sandbox (host `/tmp/.X11-unix` fails its ownership check), leaving a doomed
process that pops the gamescope WSI dialog and segfaults when dismissed. Games
present directly to the session compositor instead
(`isGamescopeSessionActive()` in `src/main/helpers/is-gamescope-available.ts`).

## Save synchronization (Steam-Cloud-like)

Backups use the local artifact store (`src/main/services/backup/`, local
directory or rclone backend); each backup is a `.tar` + `.json` sidecar with a
random `id`, `createdAt`, `hostname`, and a stable per-install `deviceId`.
Enabled per game via `automaticCloudSync`.

- **Sync-in before launch, back up on exit.** `CloudSync.syncOnLaunch` is
  awaited at the start of `launchGame` BEFORE the game spawns; the close-backup
  runs in `process-watcher` on exit. (Backing up on open was a bug — it would
  overwrite a newer cross-device backup.)
- **Marker-based, data-safe decisions** (pure logic in
  `src/main/services/backup/sync-planner.ts`, `decideLaunchSync`). `Game.lastSyncedBackupAt`
  is the createdAt of the backup this machine is in sync with. On launch: no
  backups → nothing; marker unset **and this device has NO local save files** →
  restore the latest (true Steam-Cloud first run on a fresh device — nothing to
  clobber); marker unset with local saves present (or existence undetermined) →
  adopt the latest as baseline WITHOUT restoring (migration safety — never
  overwrite possibly-newer local saves on first run); latest newer than the
  marker → restore; otherwise skip (protects a crashed session's local progress
  from being overwritten). Local-save existence is detected only on the marker-
  unset path via a ludusavi backup *preview* (`CloudSync.detectHasLocalSaves`,
  the same read-only scan the real backup uses) — a preview finding zero save
  files = no local saves. **Fail-safe (non-negotiable):** a restore happens ONLY
  on a POSITIVE zero-files determination; any error/timeout/ambiguity is treated
  as "saves exist" → adopt-baseline, never a restore.
- **Retention.** After each close-backup, prune to N (`Game.backupsToKeep` ??
  `UserPreferences.defaultBackupsToKeep` ?? 10), keeping the newest N non-frozen
  plus ALL frozen artifacts. The backups list (game options → Backup) is sorted
  newest-first and shows each backup's `hostname` with a "This PC" badge for this
  device's own backups; restore any of them manually to roll back.
- **Cross-device conflict detection.** `Game.unsyncedSince` is set when a play
  session starts and cleared on a clean close-backup, so it stays set only after
  a crash (local divergence). If, on launch, a newer backup exists from ANOTHER
  device AND this device has local divergence, that is a true conflict. It is
  resolved **keep-both** (no blocking prompt, zero data loss): this device's
  interrupted saves are backed up FIRST as a **frozen** artifact (retention never
  auto-deletes it), then the newer remote is restored and the user is warned via
  a toast. If that safety backup fails, the remote is NOT restored — local saves
  are kept intact and the conflict is retried next launch.

## Tray launches

The system-tray recent-games menu (`src/main/services/window-manager.ts`) routes
clicks through `launchGame` — the same path as the library Play button and the
deep link — so Proton/umu wrapping, the bwrap sandbox, gamescope and save sync
all apply. It must never `shell.openPath` the raw executable, which would hand
the `.exe` to the desktop handler and bypass the sandbox entirely.

## Big Picture launch flag

`--big-picture` (alias `--bigpicture`) boots the launcher straight into the
fullscreen, gamepad-friendly Big Picture window instead of the desktop window.
It is a per-launch override: it forces big-picture mode without modifying the
persisted `launchInBigPicture` preference. The flag is detected in
`src/main/index.ts` (scanning `process.argv`, matching the existing `--hidden`
handling and working the same in a packaged AppImage) and threaded into
`WindowManager.createMainWindow(forceBigPicture)` in
`src/main/services/window-manager.ts`. It wins over `--hidden` autostart, and a
second launch carrying the flag focuses the Big Picture window on the already
running instance.

Intended use on a Steam Deck / HTPC: add the AppImage to Steam as a non-Steam
game and set its launch options to boot into Big Picture:

```
--big-picture
```

### `--no-tray`

`--no-tray` (alias `--notray`) disables the system tray for this launch and makes
closing the window actually **quit** the app. Without it, closing the window on
Steam Deck gaming mode does not terminate Hydra: the close is swallowed by the
hide-to-tray behavior and the process lingers headless (gaming mode has no tray
area to reach it), so Steam keeps showing the app as running.

Like `--big-picture`, it is detected in `src/main/index.ts` (scanning
`process.argv`, so it works from source and a packaged AppImage) and is a
per-launch override that never touches any persisted preference. It does two
things: (1) `WindowManager.createSystemTray` is skipped, and (2) the flag is
stored on `WindowManager.noTray`, which routes the main-window `close` handler
and the Big Picture `closed` handler (both in
`src/main/services/window-manager.ts`) to `app.quit()` — the normal
`before-quit` cleanup path (downloads, sandboxed-game teardown, playtime flush).
In a `--big-picture` launch the desktop window is a hidden opacity-0 placeholder
under the Big Picture window; with `--no-tray`, closing the Big Picture window
quits the whole app instead of restoring that hidden placeholder (which would
otherwise keep the process alive headless).

**Quitting the launcher tears down any running sandboxed game** (the bwrap
sandbox uses `--die-with-parent` tied to the Electron main process). This is
accepted for this flag: on the Deck you close Hydra when you are done playing.

Recommended Steam Deck gaming-mode launch options (add the AppImage as a
non-Steam game):

```
--big-picture --no-tray
```

### gamescope WSI dialog mitigation

Under Steam's gamescope session (gaming mode), Chromium's GPU process would
otherwise create a Vulkan swapchain outside gamescope's hooked path, tripping
its WSI layer's modal *"CreateSwapchainKHR: Creating swapchain for non-Gamescope
swapchain. Hooking has failed somewhere!"* dialog — and dismissing it can crash
the session. `src/main/index.ts` disables Chromium's Vulkan usage with
`app.commandLine.appendSwitch("disable-features", "Vulkan,VulkanFromANGLE,DefaultANGLEVulkan")`
before app ready, so no swapchain is ever created and the dialog can't appear
(the launcher UI falls back to GL, which is fine). It is gated on the gamescope
session only (`XDG_CURRENT_DESKTOP === "gamescope"`; Deck desktop mode reports
`KDE` and keeps its normal GPU path). This is a **process-local** Chromium
switch, deliberately not an `ENABLE_GAMESCOPE_WSI=0` environment variable —
the launcher's env leaks to the games it spawns, and those must keep gamescope's
WSI.

## Startup dependency check

At startup the main process checks whether `bwrap`, `pasta` and `gamescope` are
on `PATH` (`src/main/helpers/host-dependencies.ts`) and, if any are missing,
shows one non-blocking warning toast naming what each absence disables (bwrap →
sandbox can't run; pasta → network isolation disabled; gamescope → wrapper
unavailable). Linux-only; silent when all three are present.
