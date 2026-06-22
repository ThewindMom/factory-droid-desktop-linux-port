# Factory Droid Desktop for Linux

Unofficial Linux build wrapper for [Factory Droid Desktop](https://factory.ai/product/desktop).
The official Factory Desktop app is available for macOS and Windows; this repository
covers Linux by converting the upstream macOS `Factory.dmg` into a runnable Linux
Electron app.

The project builds native `.deb` packages, supports local AppImage self-builds,
and can install a local update manager that rebuilds future Linux packages from
newer upstream DMGs.

It is **not** affiliated with, endorsed by, or supported by Factory. It does not
redistribute Factory software — it automates the conversion process that users
perform on their own copies of the official DMG.

## Install

### Debian, Ubuntu, Pop!_OS, Mint, Elementary

Download the latest `.deb` from [Releases](../../releases), then:

```bash
sudo dpkg -i factory-desktop_*_amd64.deb
sudo apt-get install -f -y
```

Or build from source:

```bash
git clone https://github.com/ThewindMom/factory-droid-desktop-linux-port.git
cd factory-droid-desktop-linux-port
make build-app
make deb
make install
```

### Other distros (AppImage self-build)

```bash
make build-app
make appimage
```

AppImage builds and repo-only generated apps do not include the native-package
updater.

### From source (Nix flake — planned)

Nix flake support is planned but not yet implemented.

## Make Targets

| Target | Description |
|---|---|
| `make build-app` | Build Linux app (auto-fetches DMG from Factory if `--dmg` omitted) |
| `make build-app DMG=/path` | Build from a specific DMG |
| `make deb` | Build `.deb` package into `dist/` |
| `make appimage` | Build AppImage into `dist/` |
| `make package` | Build native package (auto-detects distro) |
| `make install` | Install the latest native package |
| `make run-app` | Launch the built Electron app |
| `make check` | Run `cargo check` for the updater |
| `make test` | Run updater test suite |
| `make build-updater` | Build the Rust updater binary (release) |
| `make service-enable` | Enable and start `factory-update-manager.service` |
| `make service-status` | Show updater service status |
| `make clean` | Remove build artifacts and `dist/` |
| `make clean-state` | Remove updater runtime state from XDG directories |

Variables:

| Variable | Description |
|---|---|
| `DMG=/path/file.dmg` | Override the DMG to build from |
| `PACKAGE_WITH_UPDATER=0` | Build without the updater or service unit |
| `DEB=/path/file.deb` | Override the `.deb` used by `make install` |

## Feature Matrix

| Feature | Default | Enable / use | Docs |
|---|---|---|---|
| Standard Factory Desktop UI | Always | Install or run the generated app | This README |
| Linux Electron runtime | Always | Bundled during build | [How it works](#how-it-works) |
| Droid CLI binary | Always | Resolved from `@factory/cli-linux-x64` npm | [How it works](#how-it-works) |
| asar patch registry | Always | Applied during build | [Patches](#asar-patches) |
| Native packages | Always | `make package && make install` | This README |
| Auto-update manager | Native packages | Included unless `PACKAGE_WITH_UPDATER=0` | [Updater](#auto-update-manager) |
| AppImage self-build | Manual | `make build-app && make appimage` | This README |
| GitHub Releases CI | Automatic | Daily cron checks for new upstream versions | [CI](#github-releases) |
| Linux Features framework | Opt-in | Edit `linux-features/features.json` | [Linux Features](linux-features/README.md) |

## How It Works

The pipeline mirrors the [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)
model, adapted for Factory Droid Desktop:

```
Factory endpoint ──► fetch official DMG ──► extract app.asar + payloads
                                                        │
                                                        ▼
                              asar patch registry ──► assemble Linux Electron app
                                        │                      │
                                        ▼                      ▼
                    optional linux-features/      resolve Linux droid binary
                                        │                      │
                                        └──────────┬───────────┘
                                                   ▼
                                     electron-builder → .deb / AppImage
```

### 1. Fetch the official DMG

The DMG is pulled from Factory's own desktop endpoint — no manual download:

```
https://app.factory.ai/api/desktop?platform=darwin&architecture={x64|arm64}
```

The endpoint 302-redirects to a short-lived presigned S3 URL. The builder
follows the redirect, streams the DMG to `work/`, computes its SHA-256, and
parses the version from the URL.

```bash
node dist/cli.js fetch-dmg --arch x64
```

### 2. asar Patches

Linux compatibility fixes live in a **patch registry**
([`src/patches/registry.ts`](src/patches/registry.ts)). Each patch has a stable
id, a description, an `apply()`, and an isolated result. Patches use
**version-agnostic regex patterns** that match structural code shapes, not
hardcoded minified strings — so they survive upstream version bumps.

The registry currently ships three core patches:

- **`daemon-transport`** — forces WebSocket daemon transport on Linux and guards
  against `droid daemon --listen ipc` (unsupported by the Linux `droid` CLI).
  Without this, the daemon crashes on launch with `error: unknown option '--listen'`.

- **`auto-updater`** — guards `autoUpdater.checkForUpdates()` and
  `autoUpdater.quitAndInstall()` with `process.platform!=="linux"`. Factory
  Desktop's built-in auto-updater targets macOS/Windows update endpoints; on
  Linux it would fail and potentially crash the app. The Rust-based
  `factory-update-manager` handles Linux updates independently.

- **`window-controls`** — injects `titleBarOverlay` on Linux with dark/light
  theme-aware colors, giving a frameless window with Electron-drawn
  minimize/close buttons (matching the macOS/Windows aesthetic). Without this,
  the app uses `"hidden"` titleBarStyle on Linux (because it's not win32),
  resulting in no title bar at all.

### 3. Droid CLI binary

The Linux `droid` binary is distributed as `@factory/cli-linux-x64` on npm —
**not** from `downloads.factory.ai` (which returns 403 for all requests). The
builder downloads the tarball from
`https://registry.npmjs.org/@factory/cli-linux-x64/-/cli-linux-x64-{version}.tgz`,
extracts `package/bin/droid`, and stages it into `resources/bin/droid`.

Desktop version and CLI version don't always match (Desktop 0.110.0 has no
CLI 0.110.0 on npm — it jumps from 0.109.3 to 0.111.0). The resolver picks
the nearest version by numeric distance.

### 4. Optional linux-features

Optional, distro/workflow-specific integrations live in
[`linux-features/<id>/`](linux-features/) as self-contained directories with a
`feature.json` manifest, **disabled by default**. The loader
([`src/features/loader.ts`](src/features/loader.ts)) discovers only enabled
features at build time.

### 5. Assemble + package

The runtime assembly
([`src/runtime-assembly.ts`](src/runtime-assembly.ts)) stages a Linux Electron
app directory (`resources/app.asar` + `resources/bin/droid`), applies the
registered patches, and validates the layout. `electron-builder` then produces
native installers.

## Auto-Update Manager

Default native packages install `factory-update-manager`, a companion
`systemd --user` service.

It:

- checks upstream Factory Desktop DMG on daemon startup, every 6 hours, and
  in the background on app launch when stale
- rebuilds a local native package with
  `node /opt/factory-desktop/update-builder/dist/cli.js build-all`
- waits for Electron to exit before installing a ready update
- runs unprivileged; the final package install uses `pkexec` with a polkit
  policy configured for **passwordless** installation (no password prompt)
- performs rollback to the previous known-good package

### Inspect State

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

### Rollback

If a rebuilt update installs but the previous retained package was better,
close Factory Desktop and run:

```bash
factory-update-manager rollback
```

### Manual-Update Packages

Build a native package without the resident updater:

```bash
PACKAGE_WITH_UPDATER=0 make build-app
PACKAGE_WITH_UPDATER=0 make deb
make install
```

That package omits `factory-update-manager`, the user service unit, updater
polkit policy, and the bundled update builder.

## GitHub Releases

A daily GitHub Actions workflow (`.github/workflows/release.yml`) checks
`https://api.factory.ai/api/desktop/latest-version` and, if a new version is
detected that doesn't have an existing GitHub release, automatically:

1. Builds the TypeScript engine and Rust updater
2. Fetches the upstream DMG
3. Applies all registered asar patches
4. Assembles the Linux Electron app
5. Packages a `.deb` with the updater bundled
6. Creates a GitHub release with the `.deb` attached

This provides pre-built packages for users who don't want to build from
source. The Rust auto-update manager (in-app) operates independently — it
rebuilds locally from the upstream DMG rather than downloading GitHub
releases.

## Prerequisites

- Node.js `>=18` (Node 22 recommended for Electron 39)
- npm
- `7z` (**7-Zip >=21**, not p7zip-full 16.02 — modern Factory DMGs use LZFSE
  compression which p7zip cannot decompress; install from
  [7-zip.org](https://www.7-zip.org/download.html)),
  `file`, `sha256sum`, `dpkg-deb`, `desktop-file-validate`, `xdg-mime`, `xvfb-run`
- Rust (for building the updater — `make build-updater`)

Install 7-Zip >=21 (Ubuntu 22.04's `p7zip-full` ships 16.02 which cannot
handle LZFSE-compressed DMGs; the `7zip` apt package 21.07 has a Headers
Error bug on Factory DMGs — install the official 26.01 binary):

```bash
curl -sfL "https://www.7-zip.org/a/7z2601-linux-x64.tar.xz" -o /tmp/7z.tar.xz
mkdir -p /tmp/7zip && tar xf /tmp/7z.tar.xz -C /tmp/7zip
sudo install -m755 /tmp/7zip/7zz /usr/local/bin/7zz
sudo ln -sf /usr/local/bin/7zz /usr/local/bin/7z
```

Check your host:

```bash
node dist/cli.js check-tools
```

## Packaging Targets

Supported first-class targets:

- Debian package (`.deb`) — primary
- AppImage — local self-build

RPM and pacman are not yet implemented; `make package` falls back to `deb` on
non-Debian distros.

## Build the Updater

The updater is a Rust workspace in `updater/`:

```bash
cd updater
cargo build --release
# Binary: updater/target/release/factory-update-manager
```

The `make deb` and `make package` targets automatically detect the built
binary and bundle it into the deb package (unless `PACKAGE_WITH_UPDATER=0`).

## Development

```bash
npm install --no-audit --no-fund
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest --runInBand
make check           # cargo check
make test            # cargo test
```

## Troubleshooting

| Problem | First thing to try |
|---|---|
| Daemon won't start | Check `~/.factory/logs/daemon-stderr.log` for `unknown option '--listen'` — means the transport patch isn't applied |
| No window controls | The window-controls patch isn't applied — rebuild from latest source |
| Updater seems stuck | Run `factory-update-manager status --json` and check service logs |
| `make build-app` fails | Run `node dist/cli.js check-tools` to verify all dependencies are installed |

## Disclaimer

This is an unofficial community project. Factory Droid Desktop is a product of
Factory. This tool does not redistribute any Factory software; it automates the
conversion process that users perform on their own copies.

## License

MIT
