# AGENTS.md

Context file for coding agents working on this repository. Read this first;
deep operational detail lives in [docs/FORK.md](docs/FORK.md).

## What this project is

A **personal, Linux-only fork** of [hydralauncher/hydra](https://github.com/hydralauncher/hydra)
(Electron game launcher). The fork tracks upstream closely and must stay
mergeable with it. Upstream remains the source of truth for product features
and dependency bumps; this fork layers on top, in priority order:

1. **Sandboxing of launched games** (bubblewrap) — the owner runs untrusted
   Windows games via Wine/Proton and treats every game binary as hostile.
2. **Local save backups** (ludusavi artifact store) replacing Hydra Cloud,
   with Steam-Cloud-like sync semantics across devices.
3. **Local achievements** — detection was already client-side; metadata comes
   from anonymous endpoints.
4. **Linux-only packaging** — AppImage only; Windows/macOS code paths stay in
   the tree as dead code but are not built or shipped.
5. **De-account, NOT full offline** — everything requiring a Hydra *account*
   (auth, friends, profile sync, subscription gates, cloud artwork sync) is
   disabled behind the `ACCOUNTLESS` flag (`src/shared/`). Anonymous Hydra API
   calls (catalogue, download sources, assets CDN) stay.

Target hardware: Fedora desktop (AMD/Wayland/GNOME) and a Steam Deck
(gaming mode via `--big-picture --no-tray` launch options).

## Non-negotiable policies

- **Paranoia-first security defaults.** Every protection (sandbox, seccomp,
  network isolation, env scrub) ships **ON by default, opt-out**. Never
  disable a protection by default to dodge a regression — fix the regression.
- **Nothing may bypass the sandbox.** Every game-launch entry point (UI, tray,
  sidebar double-click, Steam shortcuts via deep link, CLI) must route through
  `launchGame` → `wrapWithSandbox`. When merging upstream, audit any new or
  changed launch path for bypasses (a raw `shell.openPath(exe)` in the tray
  was a real security hole once).
- **Gate, don't delete.** Account-only features are guarded behind
  `ACCOUNTLESS`, never removed — deleting diverges harder than gating.
  Cloud/subscription upsell UI (buttons, banners, "Hydra Cloud benefit"
  advertising) must be hidden under `ACCOUNTLESS`.
- **New Hydra-Cloud functionality requires owner sign-off.** If an upstream
  release introduces *new* logged-in/subscription functionality, stop and
  discuss with the owner before merging or releasing it. Inert code (guarded
  by `isLoggedIn()`/`hasActiveSubscription()`) is acceptable to merge after
  review; new upsell surfaces must be gated.
- **Trusted binaries only.** Third-party tools (umu-run, ludusavi, 7zzs,
  rclone, bwrap, pasta, gamescope) come from system packages when available,
  else pinned-sha256 official upstream releases — never Hydra mirrors or
  committed blobs. System binaries are resolved from trusted paths
  (`resolveSystemBinary`, with `~/.local/bin` last for SteamOS).
- **Stay mergeable.** New behavior in new files; surgical edits at choke
  points; no reformatting of upstream code; `win32`/`darwin` branches left
  untouched as dead code. See "Divergence principles" in docs/FORK.md.

## What the fork has implemented

All of this is on `main` and shipped; docs/FORK.md has the operational detail.

- **bwrap sandbox** per game: isolated home per game
  (`<userData>/sandbox-homes/`), env-var scrub allowlist (no host secrets leak
  into game env), per-game spoofed `/etc/machine-id`, `--die-with-parent`,
  fail-closed launch guard. Per-game and global toggles (default ON).
- **seccomp filter** (pure-Node cBPF assembler, `sandbox-seccomp.ts`):
  cumulative levels low/medium(default)/high, per-rule errno, multi-arch
  (x86_64 + i386), per-game override + audit mode (blocks → kernel log,
  decode via `journalctl -k --grep=SECCOMP`).
- **Network isolation** via pasta, podman-style single-userns (pasta runs
  *inside* bwrap as outermost command) so nested user namespaces
  (Proton pressure-vessel, gamescope) keep working. Host loopback unreachable,
  DNS forwarded. Default ON when pasta present; per-game/global opt-out.
- **gamescope integration**: per-game tri-state (default ON when binary
  detected), native resolution + refresh detection (xrandr fallback on
  Wayland), X11 socket hiding, auto-disabled inside a gamescope session
  (Deck gaming mode) to avoid nested compositors.
- **Steam-Cloud-like save sync** (ludusavi): restore-before-launch,
  backup-on-close, marker-based decisions (`sync-planner.ts`, unit-tested),
  retention with per-game keep-count, per-install device id, cross-device
  conflict detection with keep-both resolution (frozen safety backup, never
  destructive), fresh-device restore only on positive zero-local-saves
  determination. Backends: local directory (default) or system rclone.
- **Accountless features**: local game collections, achievements with local
  identity + reset, RetroAchievements via direct RA Web API (key in global
  settings), local desktop notifications, PS1/PS2 emulation saves stored
  locally, auto-backup pref for new games.
- **Big Picture parity**: all fork controls (hardening, backups, collections,
  RA credentials, toasts) exist in the Big Picture UI with gamepad
  navigation. BP i18n caveat: the DOM-walk `exact` dicts in
  `src/big-picture/src/locales/` cannot interpolate — never put `{{var}}`
  strings there; use the main i18next namespaces.
- **Steam Deck / gaming mode**: afterPack wrapper strips
  `gameoverlayrenderer.so` from `LD_PRELOAD` (Steam's overlay segfaults
  Electron's zygote), `--big-picture` / `--no-tray` CLI flags, Chromium
  Vulkan disabled under gamescope sessions, "Add to Steam" uses
  `$APPIMAGE` so shortcuts survive remounts. Launch options on Steam
  shortcuts must be bare flags — **no `%command%`** (Steam substitutes it
  with an empty string on non-Steam shortcuts).
- **Launcher-owned downloads dir** (`<userData>/Downloads`) so the sandbox
  game-dir bind never exposes user data.
- **CI**: `build.yml` single smoke job; `release.yml` on `release/**`
  branches → AppImage-only draft release, with AppImage update info
  (`.upd_info` section, for Gear Lever/AppImageUpdate) embedded post-build
  and a `.zsync` asset. Signing/telemetry removed.

## Working in this repo

- Package manager: `npx yarn <script>` (`yarn` may not be on PATH).
  Gates before any push: `npx yarn typecheck`, `npx yarn lint` (0 errors;
  warnings are pre-existing), `npx yarn test` (trust the previous commit's
  passing count as the baseline — it grows as features land).
- Husky hooks are broken in this environment: commit and push with
  `--no-verify`. Run **one commit per shell invocation** (the commit-msg hook
  environment rejects chained/multi-line commit commands).
- Commits: conventional-commits, entirely lowercase, subject line only,
  in English, atomic. No co-author trailers.
- Work directly on `main` (single-owner fork). Use a detached worktree only
  for isolated local AppImage builds (recipe in docs/FORK.md; never symlink
  extraResources — electron-builder packages dangling symlinks).
- The committed `.env` is intentional (public endpoints, no secrets).

## Updating from upstream

**Release policy: the fork follows upstream release tags.** For each upstream
release `vX.Y.Z`, merge that *tag* (not `upstream/main` HEAD) and publish the
fork's own `vX.Y.Z`. Upstream's version bump commit is inside the tag, so
`package.json` gets the right version from the merge itself. Never invent
fork-only version numbers (no `-1` suffixes — semver treats them as
pre-releases, which the auto-updater ranks BELOW the base version and never
offers); between upstream releases, fixes ride on `main` and get re-released
under the same version only if the owner asks. On owner request an **early
release** of unreleased upstream work is allowed: merge `upstream/main`,
bump to the next patch version above the last upstream tag, release it,
then replace that release when the real upstream tag lands.

Procedure per upstream release tag:

1. `git fetch upstream --tags` and inspect what's new:
   `git log --oneline --no-merges <last-merged>..vX.Y.Z`.
2. **Screen for account/cloud features first.** Grep the diff for
   `hasActiveSubscription`, `isLoggedIn`, `needsSubscription`,
   `showHydraCloudModal`, new upsell strings. *New* logged-in functionality →
   stop and discuss with the owner before proceeding. Existing-feature fixes
   and inert (auth-guarded) additions can proceed, but any new upsell UI
   must be gated behind `ACCOUNTLESS` in a follow-up commit on `main`.
3. **Screen fork-sensitive surfaces** in the incoming diff:
   - game-launch paths (anything calling `openGame`/`launchGame`/
     `shell.openPath`, tray, sidebar, shortcuts) — no sandbox bypass;
   - `create-steam-shortcut.ts` — shortcut must keep targeting the AppImage/
     deep link;
   - app startup (`src/main/index.ts`) — CLI flags (`--big-picture`,
     `--no-tray`), tray behavior, host-deps check must survive;
   - anything under our fork files (`sandbox-*.ts`, `cloud-sync`/backup,
     `resolve-*-wrapper.ts`) — usually untouched by upstream but verify;
   - preload/IPC surface used by Big Picture parity.
4. `git merge vX.Y.Z`. Resolve conflicts favoring upstream for product code,
   the fork for CI/packaging/gating (hotspot list in docs/FORK.md).
5. Run the gates (typecheck, lint, test). Fix, then verify `ACCOUNTLESS`
   branches still compile/behave (grep the conflicted files).
6. Push `main`, then cut the release:
   `git push origin main:release/X.Y.Z` → CI builds a **draft** release
   tagged `vX.Y.Z` with AppImage + `latest-linux.yml` + blockmap.
7. Publish: `gh release edit vX.Y.Z -R CappyT/hydra --draft=false --latest`.
   To replace a bad release: `gh release delete vX.Y.Z --yes` +
   `git push origin :refs/tags/vX.Y.Z`, fast-forward the `release/X.Y.Z`
   branch, let CI rebuild.
8. Smoke-test the AppImage on real hardware when the release touches launch,
   sandbox, or save-sync paths (unit tests don't cover Wine/Proton flows).

If multiple upstream releases accumulated, repeat per tag in order (merge
the oldest unmerged tag → release, then the next, …) so fork releases
mirror the upstream release history.
