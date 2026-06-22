# linux-features/

Optional Linux integrations for the Factory Droid Desktop Linux port. This is
the extension boundary modeled after `codex-desktop-linux`: the core keeps a
small generic loader, and feature-specific behavior lives in self-contained
directories, **disabled by default**.

## Layout

```
linux-features/<feature-id>/
  feature.json   # manifest (id, name, description, enabled, distros)
  README.md      # what the feature does and how to use it
```

User-local/experimental features may live under `linux-features/local/`, which
is gitignored.

## When to add a feature here vs. a core patch

- **Core patch** (`src/patches/registry.ts`): required for the app to launch
  and behave correctly on Linux for most users.
- **Feature** (`linux-features/<id>/`): optional, distro-specific,
  editor/browser/workflow-specific, or anything that adds support burden for a
  minority of users. Keep it disabled by default.

## Enabling a feature

Set `"enabled": true` in its `feature.json`. The loader
(`src/features/loader.ts`) discovers only enabled features at build time.

See `example-integration/` for a template.
