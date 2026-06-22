SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

# Factory Desktop Linux Port — Makefile
# Adapted from codex-desktop-linux Makefile structure.

APP_NAME := factory-desktop
APP_DIR := $(CURDIR)/build/factory-desktop-linux-unpacked
DIST_DIR := $(CURDIR)/dist
DEB_GLOB := $(DIST_DIR)/$(APP_NAME)_*.deb
RPM_GLOB := $(DIST_DIR)/$(APP_NAME)-*.rpm
PACKAGE_WITH_UPDATER ?= 1
UPDATER_BIN := $(CURDIR)/updater/target/release/factory-update-manager
.DEFAULT_GOAL := help

# Auto-detect native package format from /etc/os-release
NATIVE_PKG_FORMAT_CMD = format=""; \
if [ -r /etc/os-release ]; then . /etc/os-release; \
	if echo "$${ID:-} $${ID_LIKE:-}" | grep -qw arch; then format="pacman"; \
	elif echo "$${ID:-} $${ID_LIKE:-}" | grep -qwE 'fedora|rhel|centos|rocky|almalinux|opensuse|suse'; then format="rpm"; \
	elif echo "$${ID:-} $${ID_LIKE:-}" | grep -qwE 'debian|ubuntu|linuxmint|pop|elementary|zorin'; then format="deb"; \
	fi; \
fi; \
if [ -z "$$format" ]; then \
	if command -v dpkg-deb >/dev/null 2>&1; then format="deb"; \
	elif command -v rpmbuild >/dev/null 2>&1; then format="rpm"; \
	elif command -v pacman >/dev/null 2>&1; then format="pacman"; \
	fi; \
fi; \
printf '%s\n' "$$format"

.PHONY: help check test build-updater maybe-build-updater build-app package deb rpm appimage install run-app service-enable service-status clean clean-dist clean-state

help:
	@printf '\nFactory Desktop Linux Make Targets\n\n'
	@printf '  %-22s %s\n' "make check" "Run cargo check for factory-update-manager"
	@printf '  %-22s %s\n' "make test" "Run updater test suite"
	@printf '  %-22s %s\n' "make build-updater" "Build factory-update-manager (release)"
	@printf '  %-22s %s\n' "make deb" "Build .deb package into dist/"
	@printf '  %-22s %s\n' "make rpm" "Build .rpm package into dist/"
	@printf '  %-22s %s\n' "make appimage" "Build AppImage into dist/"
	@printf '  %-22s %s\n' "make package" "Build native package (auto-detects format)"
	@printf '  %-22s %s\n' "make install" "Install the latest native package"
	@printf '  %-22s %s\n' "make run-app" "Launch the built Electron app"
	@printf '  %-22s %s\n' "make service-enable" "Enable factory-update-manager --user service"
	@printf '  %-22s %s\n' "make service-status" "Show factory-update-manager service status"
	@printf '  %-22s %s\n' "make clean" "Remove build artifacts and dist/"
	@printf '  %-22s %s\n' "make clean-state" "Remove updater runtime state"
	@printf '\nVariables:\n\n'
	@printf '  %-22s %s\n' "DMG=/path/file.dmg" "Override the DMG to build from"
	@printf '  %-22s %s\n' "DEB=/path/file.deb" "Override the .deb for make install"
	@printf '  %-22s %s\n' "RPM=/path/file.rpm" "Override the .rpm for make install"
	@printf '\nExamples:\n\n'
	@printf '  %s\n' "make build-app"
	@printf '  %s\n' "make build-app DMG=/tmp/Factory.dmg"
	@printf '  %s\n' "make deb"
	@printf '  %s\n' "make package"
	@printf '  %s\n' "make install"
	@printf '  %s\n\n' "make run-app"

check:
	@echo "[make] Running cargo check"
	cd updater && cargo check

test:
	@echo "[make] Running cargo test"
	cd updater && cargo test

build-updater:
	@echo "[make] Building factory-update-manager (release)"
	cd updater && cargo build --release

maybe-build-updater:
	@case "$(PACKAGE_WITH_UPDATER)" in \
		0|false|no|off) \
			echo "[make] Skipping updater build (PACKAGE_WITH_UPDATER=0)" ;; \
		*) \
			$(MAKE) build-updater ;; \
	esac

build-app:
	@echo "[make] Building Linux app"
	node dist/cli.js build-all $(if $(DMG),--dmg $(DMG),) --targets deb

deb: maybe-build-updater
	@echo "[make] Building Debian package"
	node dist/cli.js package --app-dir "$(APP_DIR)" --output-dir "$(DIST_DIR)" --targets deb

rpm: maybe-build-updater
	@echo "[make] Building RPM package"
	node dist/cli.js package --app-dir "$(APP_DIR)" --output-dir "$(DIST_DIR)" --targets rpm
appimage:
	@echo "[make] Building AppImage"
	node dist/cli.js package --app-dir "$(APP_DIR)" --output-dir "$(DIST_DIR)" --targets appimage

package: maybe-build-updater
	@echo "[make] Building native package (auto-detecting distro)"
	@format="$$( $(NATIVE_PKG_FORMAT_CMD) )"; \
	if [ "$$format" = "pacman" ]; then \
		echo "[make] pacman is not yet supported by electron-builder. Falling back to deb." >&2; \
		format="deb"; \
	fi; \
	if [ -z "$$format" ]; then \
		echo "[make] No supported packaging tool found. Falling back to deb." >&2; \
		format="deb"; \
	fi; \
	echo "[make] Detected format: $$format"; \
	$(MAKE) "$$format"

install:
	@echo "[make] Installing latest native package"
	@format="$$( $(NATIVE_PKG_FORMAT_CMD) )"; \
	if [ -z "$$format" ]; then \
		echo "[make] No supported package manager found. Falling back to deb." >&2; \
		format="deb"; \
	fi; \
	if [ "$$format" = "deb" ]; then \
		deb="$${DEB:-$$(ls -1t $(DEB_GLOB) 2>/dev/null | head -1)}"; \
		[ -n "$$deb" ] || { echo "[make] No .deb found. Run 'make deb' first." >&2; exit 1; }; \
		echo "[make] Installing $$deb"; \
		sudo dpkg -i "$$deb"; \
		sudo apt-get install -f -y 2>/dev/null || true; \
	elif [ "$$format" = "rpm" ]; then \
		rpm="$${RPM:-$$(ls -1t $(RPM_GLOB) 2>/dev/null | head -1)}"; \
		[ -n "$$rpm" ] || { echo "[make] No .rpm found. Run 'make rpm' first." >&2; exit 1; }; \
		echo "[make] Installing $$rpm"; \
		sudo rpm -Uvh "$$rpm"; \
	elif [ "$$format" = "pacman" ]; then \
		echo "[make] pacman install: use the PKGBUILD template in packaging/linux/" >&2; \
		echo "[make]   cp packaging/linux/PKGBUILD.template /tmp/PKGBUILD" >&2; \
		echo "[make]   (edit version + sha256, then: cd /tmp && makepkg -si)" >&2; \
		exit 1; \
	else \
		echo "[make] Unsupported format: $$format" >&2; exit 1; \
	fi

run-app:
	@echo "[make] Launching Factory Desktop"
	"$(APP_DIR)/factory-desktop" --no-sandbox

service-enable:
	@echo "[make] Enabling factory-update-manager.service"
	systemctl --user daemon-reload
	systemctl --user enable --now factory-update-manager.service

service-status:
	@echo "[make] Showing factory-update-manager.service status"
	systemctl --user status factory-update-manager.service --no-pager || true

clean: clean-dist
	@echo "[make] Cleaning build artifacts"
	rm -rf "$(APP_DIR)" work/ out/ .cache/

clean-dist:
	@echo "[make] Removing dist/"
	rm -rf "$(DIST_DIR)"

clean-state:
	@echo "[make] Removing updater runtime state"
	rm -rf \
		"$$HOME/.config/factory-update-manager" \
		"$$HOME/.local/state/factory-update-manager" \
		"$$HOME/.cache/factory-update-manager"
