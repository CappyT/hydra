# Game security hardening — 2026-09-10

This implements the actionable defects from [the initial audit](SECURITY-AUDIT-2026-09-10.md).
It does not turn Wine games into virtual machines or remove the Linux graphics,
audio and kernel services from the trusted computing base. Emulator executables
remain intentionally unsandboxed. These changes are on main; no release is cut
by this work.

## Corrected boundaries

- Requested networking fails closed if trusted pasta is absent, a namespace
  cannot be created, or pasta does not configure an interface within the setup
  deadline. The wrapper compares network namespace identities, never executes
  a game on setup failure, and clears effective/permitted/ambient/inheritable
  privileges before the successful payload. `no_new_privs` prevents privilege
  acquisition across exec. The capability bounding set is not itself a grant
  of capabilities; nested unprivileged user/mount namespaces remain usable.
- Requested seccomp filter creation/opening errors refuse launch. Unsupported
  architectures and x32 encodings return ENOSYS in every level, including audit
  mode; audit still logs/allows the supported-ABI diagnostic syscall rules.
- Games no longer receive the host's shared `~/.local/share/umu` mount. Any UMU
  state created through their sandbox home belongs to that game. The existing
  `UMU_NO_RUNTIME=1` setting on sandboxed UMU launches is retained.
- Tool resolution ignores PATH. It prefers fixed system directories, validates
  ownership/write permissions along resolved paths, and searches `~/.local/bin`
  last. Relative paths and targets escaping the selected trust directory are
  rejected. Gamescope does not fall back to an unvalidated PATH lookup if the
  binary disappears. Pasta is re-resolved so installing it takes effect without
  restarting the launcher; user-bin pasta is explicitly mounted read-only.
- Linux installers cannot fall back to the desktop `.exe` handler. On Wayland
  with gamescope available and no existing gamescope session, installers use
  the private gamescope display and hide host X11 just like normal game launches.
- Writable game/prefix/extra mounts are checked for real-home ancestors, broad
  launcher roots, credential/tool directories and symlink aliases. Per-game
  sandbox homes, Wine prefixes and downloads are permitted; other launcher
  state is not. Home, identity and prefix preparation failures refuse launch.
- Input exposure is limited to individual udev-classified joystick devices,
  excluding nodes also marked as keyboards or mice. Unknown hidraw nodes and
  the entire `/dev/input` directory are not shared. Connect controllers before
  launch; devices obtaining a different node after hotplug require relaunch.
- Desktop socket mounts select the active Wayland socket, a gamescope socket,
  `pipewire-0`, and `pulse/native`. Manager sockets, arbitrary matching socket
  names and the entire PulseAudio runtime directory are no longer shared.

## Local save restore

Linux game restore builds a complete plan before replacing files. Metadata can
select a file inside the archive, but cannot select the host destination root:
Wine saves go to the configured game prefix and native saves to the persistent
sandbox home. Old Wine user paths are mapped to the current prefix user.
Windows/macOS and emulator restore implementations remain in place.

A small embedded worker uses the system `/usr/bin/python3 -I`, an explicit
minimal environment and JSON over stdin. It walks source and destination
ancestors using directory file descriptors and `O_NOFOLLOW`; sources must be
regular files. It validates all paths and stages replacements before atomically
renaming individual saves. No existing save is unlinked before a replacement
is ready. Symlink destinations are refused, and replacing a hardlink never
modifies the other link's contents. A late I/O failure can still produce a
partially completed multi-file restore; this is not a filesystem transaction.

Archive extraction rejects traversal and links and uses a unique private
scratch directory per restore. Artifact ids and game identifiers are validated
before local/rclone path construction. A remote sidecar must match the requested
game and filename before it can be cached. The writer supports the full/simple
snapshots produced by Hydra; unsupported incremental formats fail explicitly.
Saves outside the prefix/sandbox home are refused rather than implicitly
approving paths supplied by a backup. Python 3 is required for Linux restore.

## Verification

- Typecheck and production build pass. Lint reports zero errors and 79 existing
  warnings.
- `PATH=/usr/bin:/bin npx yarn test`: 654 passing tests, including real restore
  writes, malicious archive links, ancestor/source/leaf symlinks, hardlinks,
  traversal and identifier validation.
- The standalone Rust probe now has opt-in capability, network, environment,
  shared-runtime and seccomp checks. Its persistent-home heuristic accepts
  populated private homes when the runner supplies a hidden host sentinel.
  The updated sibling checkout is committed as `5c7de3c`.
- `npx yarn sandbox:selftest` requires the updated probe and tests the actual
  production builder with medium/enforce seccomp, pasta, generated DNS,
  machine-id and the environment scrubber. Four negative controls deliberately
  expose a synthetic runtime/secret and remove networking/seccomp, requiring
  the probe to detect the regressions. Missing checks or required SKIPs fail.
  The updated probe passes all 14 checks here and detects all four negative
  controls; its Rust unit suite passes 13 tests.
- `node --import ./scripts/register-ts-node.mjs scripts/sandbox-security-audit.mjs`
  reproduces the original boundaries, explicitly injects pasta setup failure,
  checks the compiled x32 policy independently of kernel support, and verifies
  that nested user/mount namespaces still work. All 25 assertions pass.
- Probe validation: `cargo test --locked`, `cargo clippy --locked --all-targets
-- -D warnings`, `cargo build --release --locked` in the sibling checkout.

Integration checks use disposable fixtures, not the owner's saves. They do not
exercise a full Wine/Proton game, gamepad hotplug, audio capture restrictions or
Steam Deck hardware. Repeat gameplay/backup/restore smoke tests on Fedora and
Deck before releasing.

## Remaining limits

The initial audit's platform exposure discussion is not a claim that all of
these services are now isolated. PulseAudio/PipeWire protocol access remains
shared and does not enforce playback-only permissions. X11 remains shared when
private gamescope wrapping is unavailable or the session already is gamescope
(Deck gaming mode). GPU ioctls and the kernel are shared. Full desktop/audio
brokering would require a separate design and compatibility testing; hiding a
Unix socket behind a read-only bind does not enforce protocol permissions.

Pasta still permits Internet and LAN traffic; no anonymity or outbound firewall
policy was added. Host-readable `/etc` and `/sys` metadata remain visible.
Resource namespaces are not memory/process/disk quotas. Explicitly choosing a
shared game directory or prefix still shares its data. The new restore writer
constrains restoration; this change is not an audit or complete isolation of
Ludusavi's host-side backup scanning or other trusted launcher services.
