[日本語](./ci-cd.ja.md)

# CI/CD Integration

This guide explains how to run TAKT from CI/CD pipelines. It covers a GitHub Actions example, non-interactive mode, and setup for other CI systems.

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

With `--pipeline`, TAKT creates a branch, runs the workflow, commits, and pushes without interaction.

Pipeline mode requires a task source: one of `--task`, `--issue`, or `--pr`. If none is given, TAKT exits with code `2`.

Add `--auto-pr` to create a PR in pipeline mode. When combined with `--skip-git`, no PR is created and TAKT prints a warning. A successful workflow exits with code `0`.

### All Pipeline Options

| Option | Description |
|--------|-------------|
| `--pipeline` | **Enable pipeline (non-interactive) mode** -- Required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR (interactive: skip confirmation, pipeline: enable PR) |
| `--draft` | Create the PR as a draft (requires `--auto-pr` or `auto_pr` config) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|claude-sdk\|claude-headless\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|devin\|pi\|mock) |
| `--model <name>` | Override agent model |
| `--auto-strategy <strategy>` | Auto routing strategy (cost\|balanced\|performance) |

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

**Specify workflow and branch name:**

```bash
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug
```

**Specify repository for PR creation:**

```bash
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

**Workflow execution only (skip branch creation, commit, push):**

```bash
takt --pipeline --task "Fix bug" --skip-git
```

With `--skip-git`, nothing is pushed, so TAKT ignores `--auto-pr` and prints a warning.

**Minimal output mode (suppress AI output for CI logs):**

```bash
takt --pipeline --task "Fix bug" --quiet
```

## Exit Codes

Pipeline mode returns these codes so CI scripts can identify the failure:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Issue/PR fetch failed, or none of `--issue` / `--pr` / `--task` was specified |
| `3` | Workflow execution failed |
| `4` | Git operation failed (environment preparation, commit, or push) |
| `5` | PR creation failed |
| `130` | Interrupted by SIGINT (Ctrl+C) |

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
| `{title}` | Commit message, PR body | Issue title |
| `{issue}` | Commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body |
| `{report}` | PR body | Fixed string: ``Workflow `{workflow}` completed successfully.`` |

`commit_message_template` is applied only when an issue is linked. With `--task` alone, the commit message is `takt: {task}`.

## Other CI Systems

For CI systems other than GitHub Actions, install TAKT globally and use pipeline mode directly:

```bash
# Install takt
npm install -g takt
takt install claude-sdk

# Run in pipeline mode
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

This approach works with any CI system that supports Node.js, including GitLab CI, CircleCI, Jenkins, Azure DevOps, and others.

## Environment Variables

Store credentials for the selected provider as CI secrets and pass them to the job as environment variables. DeepSeek Harness uses the SDK's `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` variables.

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...

# For OpenCode
export TAKT_OPENCODE_API_KEY=...

# For Pi
# Use the Pi SDK credential store or provider-native environment variables

# For DeepSeek Harness
export DEEPSEEK_API_KEY=...
# Optional: export DEEPSEEK_BASE_URL=https://...

# For Cursor Agent (optional if cursor-agent login session exists)
export TAKT_CURSOR_API_KEY=...

# For GitHub Copilot CLI
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...

# For Kiro CLI
export TAKT_KIRO_API_KEY=...
```

Priority: Environment variables take precedence over `config.yaml` settings.

Run `takt install deepseek-harness` before a DeepSeek Harness job. It supports Linux x64/arm64 with glibc 2.28 or later and macOS arm64 14.0 or later. Install the respective CLIs for Cursor, Copilot, Kiro, and Devin.

## Cost Considerations

TAKT uses AI APIs (Anthropic, OpenAI, etc.), which can incur significant costs, especially when tasks are auto-executed in CI/CD environments. Take the following precautions:

- **Monitor API usage**: Set up billing alerts with your AI provider to avoid unexpected charges.
- **Use `--quiet` mode**: Reduces output volume but does not reduce API calls.
- **Choose an appropriate workflow**: Simpler workflows use fewer API calls than multi-stage workflows (e.g., `default` with parallel reviews).
- **Limit CI triggers**: Use conditional triggers (e.g., `if: contains(github.event.comment.body, '@takt')`) to prevent unintended executions.
- **Test with `--provider mock`**: Use mock provider during CI pipeline development to avoid real API costs.

## Managed SDK installation and updates

For jobs using Claude SDK, Codex, OpenCode, Pi, or DeepSeek Harness, install the required provider before running TAKT. The job needs access to the npm registry.

```sh
takt install claude-sdk
takt install codex
takt install opencode
takt install pi
takt install deepseek-harness
takt update           # Update installed providers with version drift only
takt update codex     # Update the selected provider only
```

Install the external OpenCode CLI separately. If an installation is damaged, run `takt install <provider> --force`. To save installation time in each job, prepare an image with the required providers.
