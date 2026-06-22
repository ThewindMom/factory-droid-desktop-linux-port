{
  description = "Factory Desktop — unofficial Linux port";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Factory Desktop version (matches upstream DMG version)
        factoryVersion = "0.110.0";

        # Runtime dependencies for the Electron app
        runtimeDeps = with pkgs; [
          gtk3
          libnotify
          nss
          libxss
          libxtst
          xdg-utils
          polkit
          systemd
        ];

        # Build dependencies
        buildDeps = with pkgs; [
          nodejs_22
          rustc
          cargo
          pkg-config
          dpkg
          rpm
          xz
        ];

        # The Factory Desktop package, built from the .deb
        factory-desktop = pkgs.stdenv.mkDerivation {
          pname = "factory-desktop";
          version = factoryVersion;

          # The .deb is fetched from GitHub Releases
          src = pkgs.fetchurl {
            url = "https://github.com/ThewindMom/factory-desktop-linux/releases/download/v${factoryVersion}/factory-desktop_${factoryVersion}_amd64.deb";
            # Update this hash when the version changes:
            # nix-prefetch-url <url>
            sha256 = pkgs.lib.fakeSha256;
          };

          nativeBuildInputs = [ pkgs.dpkg pkgs.autoPatchelfHook ];

          buildInputs = runtimeDeps;

          unpackPhase = ''
            runHook preUnpack
            dpkg-deb -x $src .
            runHook postUnpack
          '';

          installPhase = ''
            runHook preInstall

            # Copy the entire app directory
            mkdir -p $out/opt/Factory
            cp -r opt/Factory/* $out/opt/Factory/

            # Install desktop entry
            mkdir -p $out/share/applications
            cp usr/share/applications/*.desktop $out/share/applications/ 2>/dev/null || true

            # Install icons
            mkdir -p $out/share/icons
            cp -r usr/share/icons/* $out/share/icons/ 2>/dev/null || true

            # Install the updater binary if present
            if [ -f "$out/opt/Factory/.factory-linux/updater/factory-update-manager" ]; then
              mkdir -p $out/bin
              cp "$out/opt/Factory/.factory-linux/updater/factory-update-manager" $out/bin/
            fi

            # Install systemd user service if present
            if [ -f "$out/opt/Factory/.factory-linux/updater/factory-update-manager.service" ]; then
              mkdir -p $out/lib/systemd/user
              cp "$out/opt/Factory/.factory-linux/updater/factory-update-manager.service" $out/lib/systemd/user/
            fi

            # Install polkit policy if present
            if [ -f "$out/opt/Factory/.factory-linux/updater/org.factory.desktop.update-manager.policy" ]; then
              mkdir -p $out/share/polkit-1/actions
              cp "$out/opt/Factory/.factory-linux/updater/org.factory.desktop.update-manager.policy" \
                $out/share/polkit-1/actions/
            fi

            # Set SUID bit on chrome-sandbox
            if [ -f "$out/opt/Factory/chrome-sandbox" ]; then
              chmod 4755 "$out/opt/Factory/chrome-sandbox"
            fi

            runHook postInstall
          '';

          # autoPatchelfHook patches the Electron binaries to find shared libs
          autoPatchelfIgnoreMissingDeps = true;

          meta = with pkgs.lib; {
            description = "Factory AI Desktop — unofficial Linux port";
            homepage = "https://github.com/ThewindMom/factory-desktop-linux";
            license = licenses.unfree;
            platforms = [ "x86_64-linux" ];
            mainProgram = "factory-desktop";
          };
        };

      in {
        packages = {
          default = factory-desktop;
          factory-desktop = factory-desktop;
        };

        # Development shell with all build tools
        devShells.default = pkgs.mkShell {
          buildInputs = buildDeps ++ runtimeDeps ++ [ pkgs.cargo-watch ];

          shellHook = ''
            echo "Factory Desktop Linux Port — development shell"
            echo "  Node: $(node --version)"
            echo "  Rust: $(rustc --version)"
            echo ""
            echo "Build commands:"
            echo "  npx tsc && node dist/cli.js build-all --targets deb"
            echo "  cd updater && cargo build --release"
          '';
        };

        # NixOS module for system-level installation
        nixosModules.factory-desktop = { config, lib, pkgs, ... }:
          with lib;
          let cfg = config.services.factory-desktop;
          in {
            options.services.factory-desktop = {
              enable = mkEnableOption "Factory Desktop auto-update manager";

              package = mkOption {
                type = types.package;
                default = factory-desktop;
                description = "Which Factory Desktop package to use.";
              };
            };

            config = mkIf cfg.enable {
              # Install the package
              environment.systemPackages = [ cfg.package ];

              # The systemd user service is installed by the package
              # Users enable it with: systemctl --user enable --now factory-update-manager
            };
          };
      });
}
