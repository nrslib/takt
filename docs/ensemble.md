# Ensemble Packages

[Japanese](./ensemble.ja.md)

Ensemble packages let you install and share TAKT pieces and facets from GitHub repositories.

## Quick Start

```bash
# Install a package
takt ensemble add github:nrslib/takt-fullstack

# Install a specific version
takt ensemble add github:nrslib/takt-fullstack@v1.0.0

# List installed packages
takt ensemble list

# Remove a package
takt ensemble remove @nrslib/takt-fullstack
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

## Package Structure

A TAKT package is a GitHub repository with a `takt-package.yaml` manifest and content directories:

```
my-takt-package/
  takt-package.yaml       # Package manifest (or .takt/takt-package.yaml)
  facets/
    personas/
      expert-coder.md
    policies/
      strict-review.md
    knowledge/
      domain.md
    instructions/
      plan.md
  pieces/
    expert.yaml
```

Only `facets/` and `pieces/` directories are imported. Other files are ignored.

### takt-package.yaml

The manifest tells TAKT where to find the package content within the repository.

```yaml
# Optional description
description: Full-stack development pieces with expert reviewers

# Path to the package root (relative to repo root, default: ".")
path: .

# Optional TAKT version constraint
takt:
  min_version: 0.22.0
```

The manifest can be placed at the repository root (`takt-package.yaml`) or inside `.takt/` (`.takt/takt-package.yaml`). The `.takt/` location is checked first.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `description` | No | - | Package description |
| `path` | No | `.` | Path to the directory containing `facets/` and `pieces/` |
| `takt.min_version` | No | - | Minimum TAKT version required (X.Y.Z format) |

## Installation

```bash
takt ensemble add github:{owner}/{repo}@{ref}
```

The `@{ref}` is optional. Without it, the repository's default branch is used.

Before installing, TAKT displays a summary of the package contents (facet counts by type, piece names, and edit permission warnings) and asks for confirmation.

### What happens during install

1. Downloads the tarball from GitHub via `gh api`
2. Extracts only `facets/` and `pieces/` files (`.md`, `.yaml`, `.yml`)
3. Validates the `takt-package.yaml` manifest
4. Checks TAKT version compatibility
5. Copies files to `~/.takt/ensemble/@{owner}/{repo}/`
6. Generates a lock file (`.takt-pack-lock.yaml`) with source, ref, and commit SHA

Installation is atomic — if it fails partway, no partial state is left behind.

### Security constraints

- Only `.md`, `.yaml`, `.yml` files are copied
- Symbolic links are skipped
- Files exceeding 1 MB are skipped
- Packages with more than 500 files are rejected
- Directory traversal in `path` field is rejected
- Symlink-based traversal is detected via realpath validation

## Using Package Content

### Pieces

Installed pieces appear in the piece selection UI under the "ensemble" category, organized by package. You can also specify them directly:

```bash
takt --piece @nrslib/takt-fullstack/expert
```

### @scope references

Facets from installed packages can be referenced in piece YAML using `@{owner}/{repo}/{facet-name}` syntax:

```yaml
movements:
  - name: implement
    persona: @nrslib/takt-fullstack/expert-coder
    policy: @nrslib/takt-fullstack/strict-review
    knowledge: @nrslib/takt-fullstack/domain
```

### 4-layer facet resolution

When a piece from an ensemble package resolves facets by name (without @scope), the resolution order is:

1. **Package-local**: `~/.takt/ensemble/@{owner}/{repo}/facets/{type}/`
2. **Project**: `.takt/facets/{type}/`
3. **User**: `~/.takt/facets/{type}/`
4. **Builtin**: `builtins/{lang}/facets/{type}/`

This means package pieces automatically find their own facets first, while still allowing user/project overrides.

## Managing Packages

### List

```bash
takt ensemble list
```

Shows installed packages with their scope, description, ref, and commit SHA.

### Remove

```bash
takt ensemble remove @{owner}/{repo}
```

Before removing, TAKT checks if any user/project pieces reference the package's facets and warns about potential breakage.

## Directory Structure

Installed packages are stored under `~/.takt/ensemble/`:

```
~/.takt/ensemble/
  @nrslib/
    takt-fullstack/
      takt-package.yaml          # Copy of the manifest
      .takt-pack-lock.yaml       # Lock file (source, ref, commit)
      facets/
        personas/
        policies/
        ...
      pieces/
        expert.yaml
```
