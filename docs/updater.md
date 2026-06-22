# Auto-Update Manager

Default native packages install `factory-update-manager`, a companion
`systemd --user` service.

It:

- checks upstream Factory Desktop DMG on daemon startup, every 6 hours, and
  in the background on app launch when stale
- rebuilds a local native package with
  `node /opt/factory-desktop/update-builder/dist/cli.js build-all`
- waits for Electron to exit before installing a ready update
- runs unprivileged; the final package install uses `pkexec` when a graphical
  polkit authentication agent is available, or keeps the package ready and
  reports a terminal `sudo /usr/bin/factory-update-manager ... --path ...`
  command when no auth agent is available

## Inspect State

```bash
systemctl --user status factory-update-manager.service
factory-update-manager status --json
sed -n '1,160p' ~/.local/state/factory-update-manager/state.json
sed -n '1,160p' ~/.local/state/factory-update-manager/service.log
```

Runtime files:

```text
~/.config/factory-update-manager/config.toml
~/.local/state/factory-update-manager/state.json
~/.local/state/factory-update-manager/service.log
~/.cache/factory-update-manager/
~/.cache/factory-desktop/launcher.log
~/.local/state/factory-desktop/app.pid
```

## Rollback

If a rebuilt update installs but the previous retained package was better,
close Factory Desktop and run:

```bash
factory-update-manager rollback
```

Rollback uses the last retained known-good package and refuses to run when no
rollback package is available.

## Manual-Update Packages

Build a native package without the resident updater:

```bash
PACKAGE_WITH_UPDATER=0 node dist/cli.js build-all
```

That package omits `factory-update-manager`, the user service unit, updater
polkit policy, and the bundled update builder.

Manual updates should come from a checkout you trust:

```bash
PACKAGE_WITH_UPDATER=0 node dist/cli.js build-all
sudo apt install ./dist/factory-desktop_*.deb
```

## Configuration

The updater reads `~/.config/factory-update-manager/config.toml`:

```toml
dmg_api_url = "https://app.factory.ai/api/desktop"
arch = "x64"
initial_check_delay_seconds = 30
check_interval_hours = 6
auto_install_on_app_exit = true
notifications = true
```

## Build the Updater

The updater is a Rust workspace in `updater/`:

```bash
cd updater
cargo build --release
# Binary: updater/target/release/factory-update-manager
```

The `build-all` and `package` CLI commands automatically detect the built
binary and bundle it into the deb package (unless `PACKAGE_WITH_UPDATER=0`).

## Maintainer Scripts

The .deb package includes two maintainer scripts wired through
electron-builder's `deb.afterInstall` and `deb.afterRemove` config keys:

- **`packaging/linux/factory-desktop.postinst`** (afterInstall): Reloads
  systemd and best-effort enables + starts the `factory-update-manager`
  `--user` service for each logged-in session.
- **`packaging/linux/factory-desktop.postrm`** (afterRemove): Stops +
  disables the `--user` service and reloads systemd. This runs on both
  `--remove` and `--purge` since electron-builder's fpm target does not
  support a separate prerm/beforeRemove hook.

The scripts iterate `/run/user/*/` to reach each user's `--user` manager
via `systemctl --user --machine="$uid@.host"`.

> **Important**: These scripts must not use dollar-brace shell syntax.
> electron-builder's `FpmTarget.writeConfigFile` runs a template macro
> regex over afterInstall/afterRemove content and throws
> `Error: Macro <name> is not defined` for any unknown name. Use `$var`
> (no braces) instead — it is valid POSIX shell and does not match the
> macro regex. The regression test `maintainer script macro safety` in
> `tests/packaging.test.ts` locks this in.

## How It Works

The updater mirrors the architecture of the codex-desktop-linux update
manager, adapted for Factory Desktop:

1. **Upstream check**: HEAD requests to the Factory Desktop API
   (`https://app.factory.ai/api/desktop?platform=darwin&architecture=x64`),
   which returns a 302 redirect to a presigned S3 URL containing the version
   (`/releases/{version}/darwin/...`). The version + content-length form the
   change fingerprint.

2. **Download**: When the fingerprint changes, downloads the DMG and computes
   SHA-256.

3. **Rebuild**: Copies the builder checkout into a per-candidate workspace and
   runs `node dist/cli.js build-all --dmg <path> --targets deb` to produce a
   fresh .deb from the new upstream DMG.

4. **Install**: When the app is not running (or after it exits), installs the
   rebuilt .deb via `pkexec apt install` (or `dpkg -i` fallback). Uses
   `pkexec` with a polkit policy for unattended graphical auth.

5. **Rollback**: Retains the previously installed package as a known-good
   rollback target. `factory-update-manager rollback` reinstalls it.
