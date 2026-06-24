# devloopd

[日本語](./devloopd.ja.md)

`devloopd` is a sidecar CLI packaged with TAKT. It provides local readiness checks and finite supervisor utilities for teams that run TAKT only through subscription/login-session CLI providers.

## Doctor

Run the doctor before long workflow runs or CI-like local automation:

```bash
devloopd doctor --subscription-only
```

The command exits with status `0` when every required check passes. It exits with status `1` when a required subscription-only guard fails.

### Checks

`devloopd doctor --subscription-only` verifies:

- `--subscription-only` was explicitly requested
- optional devloop policy YAML has `mode: subscription_only`
- API-key billing environment variables such as `OPENAI_API_KEY` or `TAKT_OPENAI_API_KEY` are absent
- required CLIs are on `PATH`: `takt`, `gh`, `codex`, `opencode`, and `agy`
- Cursor CLI is available as `cursor-agent` or `agent`
- `gh auth status` succeeds, unless `--skip-auth` is passed
- resolved TAKT config has `subscription_only: true`
- global and project TAKT config files do not contain API key config keys
- project workflows under `.takt/workflows/` pass TAKT workflow doctor validation, including subscription-only provider checks

The doctor reports forbidden environment variables and config keys by name only. It does not print secret values.

### Options

| Option | Description |
|--------|-------------|
| `--subscription-only` | Require TAKT subscription-only policy checks |
| `--repo <path>` | Repository path to inspect. Defaults to the current working directory |
| `--policy <path>` | Optional devloop policy YAML path |
| `--verbose` | Show passing checks as well as warnings and failures |
| `--skip-auth` | Skip `gh auth status` |

### Optional Policy File

Use `--policy` when a project keeps devloop policy beside its TAKT config:

```yaml
mode: subscription_only
```

Then run:

```bash
devloopd doctor --subscription-only --policy .takt/devloopd.yaml
```

If no policy file is provided, the doctor emits a warning and continues. TAKT config and workflow checks still run.

## Run

Use `devloopd run` to start a TAKT issue pipeline only after the subscription-only doctor passes:

```bash
devloopd run --issue 123 --repo owner/repo
```

The command runs the same checks as `devloopd doctor --subscription-only`. If any required guard fails, TAKT is not started.

When checks pass, `devloopd run` invokes TAKT with argv equivalent to:

```bash
takt --pipeline \
  --issue 123 \
  --workflow .takt/workflows/subscription-devloop.yaml \
  --auto-pr \
  --quiet \
  --repo owner/repo
```

### Run Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | GitHub Issue number to run through TAKT |
| `--repo <owner/repo>` | Repository used by TAKT for PR operations |
| `--workflow <path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | Optional devloop policy YAML path passed to the doctor |
| `--cwd <path>` | Repository path to run in. Defaults to the current working directory |
| `--skip-auth` | Skip `gh auth status` |
| `--no-auto-pr` | Do not pass `--auto-pr` to TAKT |
| `--no-quiet` | Do not pass `--quiet` to TAKT |

## Import And Timeline

TAKT remains the workflow engine and writes run metadata under `.takt/runs/`. `devloopd import-takt-run` imports that metadata into `.devloop/ledger.jsonl`, including artifact paths, byte sizes, and SHA-256 hashes for log and report files.

```bash
devloopd import-takt-run --latest --issue 123
devloopd timeline --issue 123
devloopd memory --write
```

The JSONL ledger is the portable MVP event log. It is ignored by Git via `.devloop/` and can be copied into a future SQLite backend without changing TAKT run outputs.

`devloopd memory` renders a compact project memory snapshot from imported run metadata. It does not read raw log content. Report artifact paths are included for follow-up inspection, while log artifacts are omitted from the memory text.

### Import Options

| Option | Description |
|--------|-------------|
| `--latest` | Import the latest TAKT run from `.takt/runs/` |
| `--run <slug>` | Import a specific TAKT run slug |
| `--issue <number>` | Associate the imported run with a GitHub Issue number |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Timeline Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--run <slug>` | Filter imported runs by TAKT run slug |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |

### Memory Options

| Option | Description |
|--------|-------------|
| `--issue <number>` | Filter imported runs by GitHub Issue number |
| `--limit <count>` | Maximum imported runs to include. Defaults to 20 |
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--output <path>` | Project-local memory output path. Defaults to `.devloop/memory.md` |
| `--write` | Write the memory file instead of rendering only |

## Merge Gate

`devloopd merge-if-safe` is the mechanical merge executor. LLM output alone never merges a PR. The command reads PR metadata with `gh pr view`, changed files with `gh pr diff --name-only`, waits for checks with `gh pr checks --watch`, and only then enables auto-merge:

```bash
devloopd merge-if-safe --pr 456 --expected-head <sha>
```

When all gates pass, devloopd runs:

```bash
gh pr merge 456 --auto --squash --delete-branch --match-head-commit <head-sha>
```

The MVP gate denies or stops before merge when:

- the required `agent:auto-merge` label is missing
- the PR is draft
- GitHub checks do not pass
- review decision is not `APPROVED`
- `--expected-head` does not match the current PR head SHA
- forbidden paths are touched, such as `.github/**`, `infra/**`, `terraform/**`, `migrations/**`, `auth/**`, `billing/**`, `payments/**`, `.env*`, `*secret*`, or `*credential*`
- human-review paths are touched, such as lockfiles, `Dockerfile`, `src/middleware*`, `src/routes*`, or `src/config*`
- diff size exceeds the default policy of 12 files or 500 changed lines

### Merge Options

| Option | Description |
|--------|-------------|
| `--pr <number-or-url>` | Pull request number or URL |
| `--repo <owner/repo>` | GitHub repository |
| `--expected-head <sha>` | Expected PR head SHA. The gate denies merge if the current PR head differs |
| `--cwd <path>` | Repository path to run `gh` from |

## Issue Scanner

`devloopd scan-issues` is the mechanical backlog scanner for daemon mode. It calls `gh issue list`, normalizes issue metadata, and classifies candidates before any LLM selector sees them.

```bash
devloopd scan-issues --repo owner/repo
```

Issue bodies and comments are untrusted input. The scanner treats them as requirements or logs only, never as instructions. If issue text asks for secrets, credential access, CI bypass, admin merge, force push, or unsafe shell commands, the issue is marked `human_required` instead of becoming an automatic candidate.

When `gh issue list` reports GitHub API rate limiting or secondary rate limiting, `scan-issues` fails with `rate_limited` classification and includes any retry-after hint it can parse. The supervisor does not start TAKT after a rate-limited scan.

Default candidate behavior:

- labels `agent:ready`, `bug`, `tests`, or `docs` make an issue eligible for mechanical consideration
- forbidden labels such as `human-required`, `security-sensitive`, `blocked`, `do-not-touch`, `billing`, `payments`, and `infra` skip the issue
- low-risk labels such as `docs` or `tests` can classify as `auto_merge_candidate`
- other eligible issues classify as `auto_pr_only`; merge still requires `devloopd merge-if-safe`

### Scan Options

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--cwd <path>` | Repository path to run `gh issue list` from |

## Start

`devloopd active-runs` inspects `.takt/runs/*/meta.json` and reports currently running TAKT runs, including stale state based on the latest metadata update.

```bash
devloopd active-runs
```

`devloopd start --once` connects the MVP supervisor path: inspect active runs, scan open issues, select the safest mechanical candidate, run TAKT for that issue, and import the latest TAKT run into the devloop ledger.

```bash
devloopd start --repo owner/repo --once
```

Long-running daemon mode is intentionally not enabled yet. Without `--once`, `devloopd start` exits before scanning or starting TAKT. This keeps the current supervisor bounded while the run scheduler and retry policy are still being hardened.

The finite cycle uses the same safety boundaries as the lower-level commands:

- `active-runs` refuses to start new work when the active run limit is reached
- `scan-issues` performs mechanical filtering first
- `auto_merge_candidate` issues are preferred over `auto_pr_only` issues
- `run` still runs the subscription-only doctor before TAKT starts
- `import-takt-run --latest` persists the run evidence after TAKT succeeds

### Active Runs Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Repository path to inspect. Defaults to the current working directory |
| `--stale-after-minutes <count>` | Minutes without metadata update before a run is stale. Defaults to 180 |

### Start Options

| Option | Description |
|--------|-------------|
| `--repo <owner/repo>` | GitHub repository |
| `--once` | Run one finite scan/run/import cycle. Required until long-running daemon mode is implemented |
| `--workflow <path>` | TAKT workflow name or path. Defaults to `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | Optional devloop policy YAML path passed to the subscription-only doctor |
| `--cwd <path>` | Repository path to run in. Defaults to the current working directory |
| `--ledger <path>` | Ledger path. Defaults to `.devloop/ledger.jsonl` |
| `--max-active-runs <count>` | Maximum active TAKT runs allowed before start refuses to scan. Defaults to 1 |
| `--stale-after-minutes <count>` | Minutes without metadata update before active-runs marks a run stale. Defaults to 180 |
| `--skip-auth` | Skip `gh auth status` |
| `--no-auto-pr` | Do not pass `--auto-pr` to TAKT |
| `--no-quiet` | Do not pass `--quiet` to TAKT |

## Subscription-Only TAKT Config

Use CLI-only providers in global or project config:

```yaml
subscription_only: true
provider: codex-cli
allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli]
```

With `subscription_only: true`, TAKT rejects SDK/API providers such as `codex` or `opencode`, API key config such as `openai_api_key`, workflow step provider overrides outside the allowlist, and execution-time `--provider` overrides outside the allowlist.
