# Factory Droid Desktop — Linux Port

Unofficial Linux port builder for [Factory Droid Desktop](https://factory.ai/product/desktop).
The official Factory Desktop app ships for macOS and Windows; this project covers
Linux by fetching the official macOS DMG from Factory's own endpoint and
assembling a runnable Linux Electron app from it.

It is **not** affiliated with, endorsed by, or supported by Factory. It does not
redistribute Factory software — it automates the conversion a user performs on
their own copy of the official DMG.

## Quick start

One command does everything — fetch the official DMG, patch it for Linux,
assemble the Electron app, and package it:

```bash
npm install --no-audit --no-fund
npm run build
./install.sh --targets deb,appimage --validate
```

By default `install.sh` fetches the x64 DMG directly from Factory's desktop
endpoint. You don't need to supply a DMG.

```bash
# Fetch arm64 instead
./install.sh --arch arm64 --targets deb,appimage --validate

# Or use a DMG you already have
./install.sh --dmg /path/to/Factory-x64.dmg --validate

# Optionally verify x64/arm64 payload parity
./install.sh --dmg /path/to/Factory-x64.dmg \
             --arm64-dmg /path/to/Factory-arm64.dmg \
             --targets deb,appimage --validate
```

Under the hood `install.sh` calls the TypeScript engine:

```bash
node dist/cli.js build-all --fetch-arch x64 --targets deb,appimage --validate
```

## How it works

The pipeline mirrors the [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)
model, adapted for Factory Droid:

```
Factory endpoint ──► fetch official DMG ──► extract app.asar + payloads
                                                        │
                                                        ▼
                              patch registry (src/patches/) ──► assemble Linux Electron app
                                        │                              │
                                        ▼                              ▼
                    optional linux-features/            resolve Linux `droid` binary
                                        │                              │
                                        └──────────────┬───────────────┘
                                                       ▼
                                         electron-builder → .deb / AppImage
```

### 1. Fetch the official DMG

The DMG is pulled from Factory's own desktop endpoint — no manual download:

```
https://app.factory.ai/api/desktop?platform=darwin&architecture={x64|arm64}
```

The endpoint 302-redirects to a short-lived presigned S3 URL of the form
`downloads.factory.ai/factory-desktop/releases/<version>/darwin/<arch>/Factory-<version>-<arch>.dmg`.
The builder follows the redirect, streams the DMG to `work/`, computes its
SHA-256, and parses the version from the URL so the matching Linux `droid`
binary can be pinned without a separate discovery call.

```bash
node dist/cli.js fetch-dmg --arch x64
```

### 2. Patch registry

Linux compatibility fixes live in a **patch registry**
([`src/patches/registry.ts`](src/patches/registry.ts)). Each patch has a stable
id, a description, an `apply()`, and an isolated result — so fixes are
discoverable, individually testable, and fail loudly when their needle is
missing across upstream version drift.

The registry currently ships one core patch:

- **`daemon-transport`** — forces WebSocket daemon transport on Linux and guards
  against `droid daemon --listen ipc` (unsupported by the Linux `droid` CLI).

### 3. Optional linux-features

Optional, distro/workflow-specific integrations live in
[`linux-features/<id>/`](linux-features/) as self-contained directories with a
`feature.json` manifest, **disabled by default**. The loader
([`src/features/loader.ts`](src/features/loader.ts)) discovers only enabled
features at build time.

Rule of thumb:

- Required for the app to launch/behave correctly on Linux for most users →
  core patch in the registry.
- Optional / distro / workflow specific → a `linux-features/` descriptor, off
  by default.

See [`linux-features/README.md`](linux-features/README.md).

### 4. Assemble + package

The runtime assembly
([`src/runtime-assembly.ts`](src/runtime-assembly.ts)) stages a Linux Electron
app directory (`resources/app.asar` + `resources/bin/droid`), applies the
registered patches, and validates the layout. `electron-builder` then produces
native installers.

## Prerequisites

- Node.js `>=18`
- npm
- `7z`, `file`, `sha256sum`, `dpkg-deb`, `desktop-file-validate`, `xdg-mime`,
  `xvfb-run`

Check your host:

```bash
node dist/cli.js check-tools
```

## Packaging targets

Supported first-class targets:

- Debian package (`.deb`)
- AppImage

RPM is deferred unless `rpmbuild` is available or an approved Docker RPM strategy
is configured; RPM requests fail fast and leave no partial artifacts.

## Release metadata and update modes

Safe/source-only mode is the default — it refuses to publish binary artifacts
or generate update metadata that implies proprietary binary availability:

```bash
node dist/cli.js release-metadata --release-mode safe --release-version 0.108.0 --validate
```

Permission-cleared mode may generate GitHub Releases metadata for `.deb` and
AppImage artifacts **only** when redistribution approval exists, without
hijacking Factory's official macOS/Windows update channel:

```bash
node dist/cli.js release-metadata \
  --release-mode permission-cleared \
  --release-version 0.108.0 \
  --repo-owner <owner> --repo-name <repo> --validate
```

Version discovery and update guidance:

```bash
node dist/cli.js discover-version --latest
node dist/cli.js update-check --current-version 0.108.0
node dist/cli.js update-guidance --current-version 0.108.0
```

## Generated files and artifact hygiene

Generated directories are gitignored and must never be committed, including any
`.dmg`, `.deb`, `.rpm`, `.AppImage`, `.asar`, extracted `Factory.app` contents,
or downloaded `droid` binaries:

- `work/` — fetched DMGs, extraction workspace, downloaded `droid`
- `build/` — assembled Linux Electron app
- `dist/` — TypeScript output and release metadata/checksums
- `out/` — package output
- `.cache/` — local cache

## Development

```bash
npm run build       # tsc → dist/
npm run validate    # lint + typecheck + jest (runInBand)
npm run lint
npm run typecheck
npm test
```

## License

MIT. This is an unofficial community project. Factory Droid Desktop is a
product of Factory. This tool does not redistribute any Factory software.
