[日本語](./ci-cd.ja.md)

# CI/CD Integration

TAKT can be integrated into CI/CD pipelines to automate task execution, PR reviews, and code generation. This guide covers GitHub Actions setup, pipeline mode options, and configuration for other CI systems.

## GitHub Actions

TAKT provides the official [takt-action](https://github.com/nrslib/takt-action) for GitHub Actions integration.

### Complete Workflow Example

```yaml
name: TAKT

on:
  issue_comment:
    types: [created]

jobs:
  takt:
    if: contains(github.event.comment.body, '@takt')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run TAKT
        uses: nrslib/takt-action@main
        with:
          anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Permissions

The following permissions are required for `takt-action` to function correctly:

| Permission | Required For |
|------------|-------------|
| `contents: write` | Creating branches, committing, and pushing code |
| `issues: write` | Reading and commenting on issues |
| `pull-requests: write` | Creating and updating pull requests |

## Pipeline Mode

Specifying `--pipeline` enables non-interactive pipeline mode. It automatically creates a branch, runs the piece, commits, and pushes. This mode is designed for CI/CD automation where no human interaction is available.

In pipeline mode, PRs are **not** created unless `--auto-pr` is explicitly specified.

### All Pipeline Options

| Option | Description |
|--------|-------------|
| `--pipeline` | **Enable pipeline (non-interactive) mode** -- Required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --piece <name or path>` | Piece name or path to piece YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, piece-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|codex\|opencode\|mock) |
| `--model <name>` | Override agent model |

### Command Examples

**Basic pipeline execution:**

```bash
takt --pipeline --task "Fix bug"
```

**Pipeline execution with automatic PR creation:**

```bash
takt --pipeline --task "Fix bug" --auto-pr
```

**Link a GitHub issue and create a PR:**

```bash
takt --pipeline --issue 99 --auto-pr
```

**Specify piece and branch name:**

```bash
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug
```

**Specify repository for PR creation:**

```bash
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

**Piece execution only (skip branch creation, commit, push):**

```bash
takt --pipeline --task "Fix bug" --skip-git
```

**Minimal output mode (suppress AI output for CI logs):**

```bash
takt --pipeline --task "Fix bug" --quiet
```

## Pipeline Template Variables

Pipeline configuration in `~/.takt/config.yaml` supports template variables for customizing commit messages and PR bodies:

```yaml
pipeline:
  default_branch_prefix: "takt/"
  commit_message_template: "feat: {title} (#{issue})"
  pr_body_template: |
    ## Summary
    {issue_body}
    Closes #{issue}
```

| Variable | Available In | Description |
|----------|-------------|-------------|
| `{title}` | Commit message | Issue title |
| `{issue}` | Commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body |
| `{report}` | PR body | Piece execution report |

## Other CI Systems

For CI systems other than GitHub Actions, install TAKT globally and use pipeline mode directly:

```bash
# Install takt
npm install -g takt

# Run in pipeline mode
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

This approach works with any CI system that supports Node.js, including GitLab CI, CircleCI, Jenkins, Azure DevOps, and others.

## Environment Variables

For authentication in CI environments, set the appropriate API key environment variable. These use TAKT-specific prefixes to avoid conflicts with other tools.

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...

# For OpenCode
export TAKT_OPENCODE_API_KEY=...
```

Priority: Environment variables take precedence over `config.yaml` settings.

> **Note**: If you set an API key via environment variable, installing Claude Code, Codex, or OpenCode CLI is not necessary. TAKT directly calls the respective API.

## Cost Considerations

TAKT uses AI APIs (Claude or OpenAI), which can incur significant costs, especially when tasks are auto-executed in CI/CD environments. Take the following precautions:

- **Monitor API usage**: Set up billing alerts with your AI provider to avoid unexpected charges.
- **Use `--quiet` mode**: Reduces output volume but does not reduce API calls.
- **Choose appropriate pieces**: Simpler pieces (e.g., `default-mini`) use fewer API calls than multi-stage pieces (e.g., `default` with parallel reviews).
- **Limit CI triggers**: Use conditional triggers (e.g., `if: contains(github.event.comment.body, '@takt')`) to prevent unintended executions.
- **Test with `--provider mock`**: Use mock provider during CI pipeline development to avoid real API costs.
