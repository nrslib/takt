# Repertoire Packages

[Japanese](./repertoire.ja.md)

Repertoire packages let you install and share TAKT workflows and facets from GitHub repositories.

## Quick Start

```bash
# Install a package
takt repertoire add github:nrslib/takt-fullstack

# Install a specific version
takt repertoire add github:nrslib/takt-fullstack@v1.0.0

# List installed packages
takt repertoire list

# Remove a package
takt repertoire remove @nrslib/takt-fullstack
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

## Package Structure

A TAKT package is a GitHub repository with a `takt-repertoire.yaml` manifest and content directories:

```
my-takt-repertoire/
  takt-repertoire.yaml       # Package manifest (or .takt/takt-repertoire.yaml)
  facets/
    personas/
      expert-coder.md
    policies/
      strict-review.md
    knowledge/
      domain.md
    instructions/
      plan.md
  workflows/
    expert.yaml
```

Only `facets/` and `workflows/` directories are imported. Other files are ignored.

### takt-repertoire.yaml

The manifest tells TAKT where to find the package content within the repository.

```yaml
# Optional description
description: Full-stack development workflows with expert reviewers

# Path to the package root (relative to repo root, default: ".")
path: .

# Optional TAKT version constraint
takt:
  min_version: 0.22.0
```

The manifest can be placed at the repository root (`takt-repertoire.yaml`) or inside `.takt/` (`.takt/takt-repertoire.yaml`). The `.takt/` location is checked first.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `description` | No | - | Package description |
| `path` | No | `.` | Path to the directory containing `facets/` and workflow definitions in `workflows/` |
| `takt.min_version` | No | - | Minimum TAKT version required (X.Y.Z format) |

## Installation

```bash
takt repertoire add github:{owner}/{repo}@{ref}
```

The `@{ref}` is optional. Without it, the repository's default branch is used.

Before installing, TAKT displays a summary of the package contents (facet counts by type, workflow names, and edit permission warnings) and asks for confirmation.

### What happens during install

1. Downloads the tarball from GitHub via `gh api`
2. Extracts only `facets/` and workflow files from `workflows/` (`.md`, `.yaml`, `.yml`)
3. Validates the `takt-repertoire.yaml` manifest
4. Checks TAKT version compatibility
5. Copies files to `~/.takt/repertoire/@{owner}/{repo}/`
6. Generates a lock file (`.takt-repertoire-lock.yaml`) with source, ref, and commit SHA

Installation is atomic — if it fails partway, no partial state is left behind.

### Security constraints

- Only `.md`, `.yaml`, `.yml` files are copied
- Symbolic links are skipped
- Files exceeding 1 MB are skipped
- Packages with more than 500 files are rejected
- Directory traversal in `path` field is rejected
- Symlink-based traversal is detected via realpath validation

## Using Package Content

### Workflows

Installed workflows appear in the workflow selection UI under the "repertoire" category, organized by package. You can also specify them directly:

```bash
takt --workflow @nrslib/takt-fullstack/expert
```

### @scope references

Facets from installed packages can be referenced in workflow YAML using `@{owner}/{repo}/{facet-name}` syntax:

```yaml
steps:
  - name: implement
    persona: @nrslib/takt-fullstack/expert-coder
    policy: @nrslib/takt-fullstack/strict-review
    knowledge: @nrslib/takt-fullstack/domain
```

### 4-layer facet resolution

When a workflow from a repertoire package resolves facets by name (without @scope), the resolution order is:

1. **Package-local**: `~/.takt/repertoire/@{owner}/{repo}/facets/{type}/`
2. **Project**: `.takt/facets/{type}/`
3. **User**: `~/.takt/facets/{type}/`
4. **Builtin**: `builtins/{lang}/facets/{type}/`

This means package workflows automatically find their own facets first, while still allowing user/project overrides.

## Managing Packages

### List

```bash
takt repertoire list
```

Shows installed packages with their scope, description, ref, and commit SHA.

### Remove

```bash
takt repertoire remove @{owner}/{repo}
```

Before removing, TAKT checks if any user/project workflows reference the package's facets and warns about potential breakage.

## Directory Structure

Installed packages are stored under `~/.takt/repertoire/`:

```
~/.takt/repertoire/
  @nrslib/
    takt-fullstack/
      takt-repertoire.yaml          # Copy of the manifest
      .takt-repertoire-lock.yaml    # Lock file (source, ref, commit)
      facets/
        personas/
        policies/
        ...
      workflows/              # Workflow definitions in repertoire packages
        expert.yaml
```
