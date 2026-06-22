#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# Factory Droid Desktop — Linux Port Installer
#
# Thin entry point (mirrors the codex-desktop-linux model). Fetches the
# official Factory Desktop macOS DMG from Factory's own endpoint when no
# --dmg is supplied, then drives the TypeScript build pipeline.
#
# This is an unofficial community project. It does not redistribute Factory
# software; it automates the conversion a user performs on their own copy.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ID="${FACTORY_APP_ID:-factory-droid-desktop}"
DISPLAY_NAME="${FACTORY_DISPLAY_NAME:-Factory Droid Desktop}"

DMG=""
ARCH="x64"
ARM64_DMG=""
TARGETS="deb,appimage"
EXTRA_ARGS=()

usage() {
  cat <<EOF >&2
Usage: $0 [options]

  --dmg <path>            Use a local macOS x64 DMG (default: fetch from Factory)
  --arch <x64|arm64>      Architecture to fetch from Factory (default: x64)
  --arm64-dmg <path>      Local arm64 DMG for x64/arm64 parity checking
  --targets <list>        Comma-separated: deb,appimage (default: deb,appimage)
  --validate              Validate each build step and package contents
  --version <version>     Pin a Factory Desktop version
  --latest                Discover and use the latest Factory Desktop version
  -h, --help              Show this help

Environment:
  FACTORY_APP_ID          Override the app id (default: factory-droid-desktop)
  FACTORY_DISPLAY_NAME    Override the display name

The DMG is fetched from Factory's official desktop endpoint:
  https://app.factory.ai/api/desktop?platform=darwin&architecture=<arch>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg) DMG="$2"; shift 2;;
    --arch) ARCH="$2"; shift 2;;
    --arm64-dmg) ARM64_DMG="$2"; shift 2;;
    --targets) TARGETS="$2"; shift 2;;
    --validate) EXTRA_ARGS+=("--validate"); shift;;
    --version) EXTRA_ARGS+=("--factory-version" "$2"); shift 2;;
    --latest) EXTRA_ARGS+=("--latest"); shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

if [[ "$ARCH" != "x64" && "$ARCH" != "arm64" ]]; then
  echo "Invalid --arch '$ARCH'. Must be 'x64' or 'arm64'." >&2
  exit 1
fi

# Ensure dependencies are present.
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  echo "Installing dependencies..." >&2
  (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund)
fi

# Build the TypeScript engine if needed.
if [[ ! -f "$SCRIPT_DIR/dist/cli.js" ]]; then
  echo "Building the builder..." >&2
  (cd "$SCRIPT_DIR" && npm run build)
fi

echo ""
echo "============================================"
echo "  $DISPLAY_NAME — Linux Port Builder"
echo "============================================"

BUILD_ARGS=()
if [[ -n "$DMG" ]]; then
  BUILD_ARGS+=("--dmg" "$DMG")
else
  echo "No --dmg supplied; the official DMG will be fetched from Factory." >&2
  BUILD_ARGS+=("--fetch-arch" "$ARCH")
fi
if [[ -n "$ARM64_DMG" ]]; then
  BUILD_ARGS+=("--arm64-dmg" "$ARM64_DMG")
fi
BUILD_ARGS+=("--targets" "$TARGETS")
BUILD_ARGS+=("${EXTRA_ARGS[@]}")

echo "Running: node dist/cli.js build-all ${BUILD_ARGS[*]}" >&2
echo ""

(cd "$SCRIPT_DIR" && node dist/cli.js build-all "${BUILD_ARGS[@]}")
