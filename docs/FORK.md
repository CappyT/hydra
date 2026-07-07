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
