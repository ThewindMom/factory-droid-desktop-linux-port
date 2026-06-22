# Factory Desktop for Linux

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
git clone https://github.com/ThewindMom/factory-desktop-linux.git
cd factory-desktop-linux
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

### From source (Nix flake)

A `flake.nix` is included for NixOS and Nix users. It builds the package
from the published `.deb` using `autoPatchelfHook`:

```bash
# Build the package
nix build .#factory-desktop

# Enter a development shell with all build tools
nix develop

# Install on NixOS (adds the NixOS module)
nix profile install .#factory-desktop
```

The flake fetches the `.deb` from GitHub Releases. Update the `sha256`
in `flake.nix` when the version changes (use `nix-prefetch-url`).

## Make Targets

| Target | Description |
|---|---|
| `make build-app` | Build Linux app (auto-fetches DMG from Factory if `--dmg` omitted) |
| `make build-app DMG=/path` | Build from a specific DMG |
| `make deb` | Build `.deb` package into `dist/` |
| `make rpm` | Build `.rpm` package into `dist/` |
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
| `RPM=/path/file.rpm` | Override the `.rpm` used by `make install` |

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
| GitHub Releases CI | Automatic | Pushes + daily cron check for new upstream versions | [CI](#github-releases) |
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
  against `droid daemon --listen ipc`. While the latest droid CLI supports
  `--listen` with choices `websocket`/`ipc`, IPC transport is unreliable on
  Linux due to missing IPC channel setup. The patch forces WebSocket as
  defense-in-depth.

- **`auto-updater`** — guards `autoUpdater.checkForUpdates()` and
  `autoUpdater.quitAndInstall()` with `process.platform!=="linux"`. Factory
  Desktop's built-in auto-updater targets macOS/Windows update endpoints; on
  Linux it would fail and potentially crash the app. The Rust-based
  `factory-update-manager` handles Linux updates independently.

- **`window-controls`** — injects `titleBarOverlay` on Linux with static dark
  colors (`#1e1e1e` background, `#cccccc` symbols), giving a frameless window
  with Electron-drawn minimize/maximize/close buttons. Static colors are used
  because `nativeTheme` may not be initialized at BrowserWindow construction
  time, causing the window to silently fail to appear. Without this, the app
  uses `"hidden"` titleBarStyle on Linux (because it's not win32), resulting in
  no title bar at all.

### 3. Droid CLI binary

The Linux `droid` binary is distributed as `@factory/cli-linux-x64` on npm —
**not** from `downloads.factory.ai` (which returns 403 for all requests). The
builder downloads the tarball from
`https://registry.npmjs.org/@factory/cli-linux-x64/-/cli-linux-x64-{version}.tgz`,
extracts `package/bin/droid`, and stages it into `resources/bin/droid`.

Desktop version and CLI version don't always match (Desktop 0.110.0 has no
CLI 0.110.0 on npm — it jumps from 0.109.3 to 0.111.0). The resolver always
uses the **latest version from npm** to ensure all daemon JSON-RPC methods are
supported (older versions like 0.109.3 lack `daemon.list_custom_models`, which
breaks the Custom Models settings page).

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

The daemon has **two independent update paths**:

### Port build updates (new `.deb` from GitHub Releases)

The daemon checks GitHub Releases for new port builds — `.deb` packages with
the latest patches, droid, and asar fixes. It compares the `portBuildSha` in
the installed `build-info.json` against the commit SHA the release tag points
to (queried via the GitHub git refs API). If they differ, the daemon downloads
the `.deb` and installs it using the same pkexec + polkit flow as upstream
updates.

Port updates take priority over upstream DMG rebuilds — they include the latest
patches AND the latest droid, so they're strictly newer.

### Upstream DMG updates (new Factory Desktop version)

The daemon checks the upstream Factory Desktop DMG endpoint on startup, every
6 hours, and on app launch when stale. When a new DMG version is detected, it
downloads the DMG and rebuilds a local `.deb` using the builder code bundled at
`.deb` install time (`/opt/factory-desktop/update-builder/`).

### Shared install flow

Both update paths converge on the same install machinery:

- Waits for Electron to exit before installing a ready update
- Runs unprivileged; the final package install uses `pkexec` with a polkit
  policy configured for **passwordless** installation (no password prompt)
- Performs rollback to the previous known-good package

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

A GitHub Actions workflow (`.github/workflows/release.yml`) rebuilds the `.deb`
on every push to `master` (when `src/`, `packaging/`, `patches/`, `updater/`,
or workflow files change), and also runs a daily cron check for new upstream
versions.

The workflow:

1. Builds the TypeScript engine and Rust updater
2. Fetches the upstream DMG
3. Applies all registered asar patches
4. Assembles the Linux Electron app
5. Packages a `.deb` with the updater bundled
6. Creates or updates a GitHub release with the `.deb` attached
7. Moves the release tag to the current commit

Release notes include the build SHA, commit log since the previous release,
and the build timestamp.

The daemon's port-update check reads the tag's commit SHA directly via the
GitHub git refs API — not `target_commitish` (which may be a branch name or
stale).

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
- RPM package (`.rpm`) — for Fedora/RHEL/openSUSE
- AppImage — local self-build

Pacman (Arch Linux) is supported via a `PKGBUILD` template at
`packaging/linux/PKGBUILD.template`, which wraps the `.deb` extraction.
`make package` auto-detects the distro and builds the appropriate format;
`make rpm` builds RPM directly.

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
| No window controls | The window-controls patch isn't applied — rebuild from latest source |
| Daemon won't start | Check `~/.factory/logs/daemon-stderr.log` for transport errors — means the daemon-transport patch isn't applied |
| `make build-app` fails | Run `node dist/cli.js check-tools` to verify all dependencies are installed |
| Custom Models page empty | The bundled droid is too old — rebuild from latest source to get the latest droid from npm |

## Disclaimer

This is an unofficial community project. Factory Droid Desktop is a product of
Factory. This tool does not redistribute any Factory software; it automates the
conversion process that users perform on their own copies.

## License

MIT
