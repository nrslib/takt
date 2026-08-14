# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is not user-facing documentation.** It exists for Claude Code to read while working in the repository — it does not substitute for the real docs under `docs/` or `README.md`. Content being recorded here NEVER implies "we don't need to write this up for users." Anything users should see must still be added to `README.md` / `docs/**` separately.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration CLI. It runs AI agents through YAML-defined workflows with rule-based routing, parallel review, dynamic task decomposition, and worktree-isolated execution. This repository dogfoods TAKT for its own review and development.

## Development Commands

| Command | Notes |
|---------|-------|
| `npm run build` | `tsc` (+ opencode-probe tsconfig) plus copies of `src/shared/prompts/{en,ja}/**/*.md`, `src/shared/i18n/*.yaml`, and `src/core/runtime/presets/*.sh` into `dist/`. Skipping any copy breaks runtime resolution. |
| `npm run watch` | TypeScript incremental build (no asset copy). |
| `npm run lint` | ESLint on `src/`. `no-explicit-any` is error; unused vars must be prefixed `_`. |
| `npm test` | Fast unit gate: type-contracts tsc, then 4 shards launched **concurrently** (`Promise.all` in `scripts/run-npm-test.mjs`, each shard `--maxWorkers=1`). Excludes integration tests; the output names the follow-up command. |
| `npm run test:it` | Light integration gate for real filesystem, SQLite, bounded storage, and multi-component contracts. Run after implementation. |
| `npm run test:it:heavy` | Full heavy integration gate for real child processes, Git, complete engines, integration/regression/performance suites, and serial groups. Local execution uses one worker; PR CI shards across isolated runners. |
| `npm test -- src/__tests__/<file>.test.ts` | Route a single file to the correct unit, light-IT, heavy-parallel-IT, or heavy-serial-IT runner. For an added or changed IT, also run `releaseVerificationWiring.test.ts` by itself. Always target-run an added or changed heavy IT before handoff. |
| `npm test -- -t "<pattern>"` | Run unit tests whose name matches `<pattern>`. |
| `npm run test:opencode-probe` | Deterministic OpenCode probe smoke gate (11 cases, no API cost). Standalone; not part of routine gates or `check:release`. |
| `npm run test:e2e:mock` | Full mock-provider E2E suite (parallel shards). Single spec: `npx vitest run --config vitest.config.e2e.mock.ts e2e/specs/<file>.e2e.ts`. |
| `npm run test:e2e:provider:{claude,claude-sdk,codex,opencode,cursor}` | E2E against a real provider (slow, costs API credits). |
| `npm run check:release` | Full pre-release gate: build + lint + fast 4-shard unit + light IT + heavy IT + e2e. |

### Test pool behavior (worth knowing before "fixing" flakes)

- Test-layer membership lives in `scripts/test-classification.mjs`. `lightIntegrationTestFiles` covers bounded filesystem/storage and component contracts; `heavyParallelIntegrationTestFiles`, integration filename globs, and the serial groups cover real processes, Git, full engines, and measured IO interference. `releaseVerificationWiring.test.ts` fails if a listed file does not exist, overlaps another group, or leaves an observed boundary in unit.
- `dangerouslyIgnoreUnhandledErrors: !process.env.CI` (vitest.config.shared.ts): the spurious `[vitest-worker]: Timeout calling "onTaskUpdate"` error is tolerated locally (4 concurrent unit shards on one machine) but **fatal on CI**. Heavy parallel IT always uses one worker per runner; PR CI scales out through four isolated job-level shards, while local full-heavy execution stays serial.
- Because that noise still makes a shard exit non-zero locally, `npm test` re-measures such a shard **once** (`scripts/vitest-birpc-noise.mjs`): only when the shard's own output shows zero failed tests, at least one passed test, and no reported error other than `[vitest-worker]: Timeout calling "onTaskUpdate"`. One real test failure, one unrecognized error headline, or `CI` set → no re-measurement, exit code stands. The re-measurement is announced on stderr; a silent shard exit is never rescued. The same one-time re-measurement now applies to `npm run test:e2e:mock` shards after the parallel wave completes.
- Reading that output means unit and mock E2E shards run through a pipe (`scripts/teed-command.mjs`) instead of inheriting the terminal, so **`npm test` and `npm run test:e2e:mock` output is now non-TTY: no color and no live progress rewriting**. That module takes the exit code from `exit` and gives `close` only a short deadline — a shard's grandchild can hold the stdout pipe open forever, and waiting on `close` alone hangs the gate.
- `src/__tests__/test-setup.ts` clears `TAKT_CONFIG_DIR` / `TAKT_NOTIFY_WEBHOOK` per test and provides an isolated config root — don't add per-suite env overrides that fight it.

## CLI Surface

Entry point: `bin/takt` → `dist/app/cli/index.js` (`src/app/cli/index.ts`). Subcommand definitions live in `src/app/cli/commands.ts`; argumentless/slash-fallback routing is in `src/app/cli/routing.ts`. See `commands.ts` for the full list rather than maintaining a copy here.

Two execution modes share the same engine: **Interactive** (`src/features/interactive/`; `/go` executes, `/cancel` aborts) and **Pipeline** (`src/features/pipeline/`, `--pipeline`; auto-branch/commit/push, `--auto-pr`, `--skip-git`).

## Architecture

### Layered layout (`src/`)

```text
app/cli/       CLI entrypoint, command wiring, routing
core/          Engine internals — no IO providers here
  workflow/    Engine, step executors, rule evaluation, instruction builder
  config/      Workflow/global/project config models
  models/      Shared domain types + Zod schemas
  runtime/     Runtime environment & shell presets
features/      User-facing feature modules (interactive, pipeline, tasks, ...)
infra/         Adapters — providers, fs, git/github/gitlab,
               observability, config loaders
shared/        Constants, i18n, ui, utils, prompt templates
agents/        agent-usecases (executeAgent, generateReport, judgeStatus, ...)
```

### Workflow execution

`WorkflowEngine` (`src/core/workflow/engine/WorkflowEngine.ts`) is an EventEmitter-driven state machine. Per-step dispatch: `StepExecutor` (normal, 3-phase), `ParallelRunner` (`parallel:`, Promise.allSettled + `all()`/`any()` aggregation), `ArpeggioRunner` (`arpeggio:` data-driven batch), `TeamLeaderRunner` (`team_leader:` runtime decomposition), `WorkflowCallExecutor` (`workflow_call:` subworkflow in the same run). `LoopDetector` catches consecutive same-step repeats; `CycleDetector` + `loop_monitors` catch cyclic patterns (judge personas routed under the fixed persona key **`loop-judge`**, not `supervisor`).

### Three-phase step model

Each normal step runs up to three phases on the same provider session: Phase 1 main work (step's `allowed_tools`; `Write` excluded when a report is defined), Phase 2 report output (`Write` only, when `output_contracts` defined), Phase 3 status judgment (no tools, when tag-based rules exist). Implemented in `phase-runner.ts` / `report-phase-runner.ts` / `status-judgment-phase.ts`.

### Rule evaluation (5-stage fallback)

`src/core/workflow/evaluation/` — first match wins: (1) aggregate `all()`/`any()` for parallel parents, (2) Phase 3 `[STEP:N]` tag, (3) Phase 1 tag, (4) AI judge for `ai("...")` conditions, (5) AI judge over every condition. Deterministic `when(...)` expressions are evaluated before tags. Quirks: tag rules match by array **index**; multiple tags → last match wins; if rules exist but nothing matches the workflow **fails fast** — silently picking a default is a bug.

### Instruction assembly

`InstructionBuilder` (`src/core/workflow/instruction/`) auto-injects execution context, workflow context, `{task}`, `{previous_response}`, `{user_inputs}`, and status output rules. **Templates contain only step-specific content** — never repeat what the builder injects. Facet markdown may include partials via `{{include:instructions/<name>}}` (resolved from `facets/partials/`).

### Provider integration

`src/infra/providers/` exposes a unified `Provider` interface. Registered: `claude-sdk`, `claude` (headless CLI), `codex`, `opencode` (shared server pool), `pi` (Pi SDK), `cursor`, `copilot`, `kiro`, `mock`. **Provider errors must surface through `AgentResponse.error`** — otherwise SDK failures appear as empty `blocked` output and are nearly impossible to debug. Use `--provider mock` to exercise the engine without a real API.

### Provider/model resolution priority

Verified against `resolveStepProviderModel` / `PROVIDER_MODEL_SOURCE_PRIORITY` and runtime tests (2026-08). Provider and model resolve independently; highest first:

1. CLI / environment explicit override
2. Matching `promotion` (normal agent steps only — parallel sub-steps **reject** `promotion` at schema level)
3. Step / parallel sub-step direct `provider` / `model`
4. `workflow_call` override
5. `provider_routing.steps` → `provider_routing.tags` → `provider_routing.personas`
6. `persona_providers` (deprecated)
7. Auto routing (`auto.rules` / `auto.dynamic` / `auto.fallback`)
8. Workflow → project (`.takt/config.yaml`) → global (`~/.takt/config.yaml`) → provider default

### Config & workflow loading

`src/infra/config/loaders/`. Workflow resolution is 3-layer with project priority: `.takt/workflows/` → `~/.takt/workflows/` → bundled `builtins/{lang}/workflows/`. Zod schemas in `src/core/models/schemas.ts` (Zod v4). Load-time provider validation for workflow_call chains uses the same routing transformation helpers as runtime (`workflow-call-provider-context.ts`) — keep them shared; divergence between load-time and runtime resolution is a bug class we have shipped before.

### Worktree-isolated execution

`worktree: true` runs a task in a `git clone --shared` (not a real git worktree — Claude Code follows `.git`-file `gitdir:` pointers back to the main repo, which breaks isolation). Clones are ephemeral (auto-commit + push on success, deleted after), contain only tracked files, and cannot resume sessions (`cwd !== projectCwd`). `cwd` = clone path, `projectCwd` = repo root; reports go to `cwd/.takt/runs/{slug}/reports/`.

## Faceted Prompting

Prompts are split into facet kinds — keep additions in the right bucket:

| Facet | Holds |
|---|---|
| `personas/` | WHO — identity, expertise. Reusable across workflows; no workflow-specific procedures. |
| `policies/` | HOW — REJECT/APPROVE criteria. **Reviewers only enforce what's in policy.** |
| `knowledge/` | WHAT TO KNOW — domain patterns, anti-patterns, examples. |
| `instructions/` | WHAT TO DO NOW — step-bound procedures. |
| `partials/instructions/` | Shared fragments injected via `{{include:...}}`. Headless (no H1) by design. |

Output contracts live under `facets/output-contracts/`. User overrides: `~/.takt/facets/<type>/` or `.takt/facets/<type>/`.

## Runtime directory layout

```text
~/.takt/                Global user config (config.yaml, workflows/, facets/, repertoire/)
.takt/                  Project config (highest priority)
  config.yaml           provider / provider_routing / quality gates / overrides
  workflows/, facets/   project-level overrides
  tasks.yaml, tasks/    queued task specs
  runs/{slug}/          per-run reports, logs, metadata, and context
  logs/, events/        NDJSON session logs / analytics (gitignored)
builtins/{en,ja}/       Bundled facets + workflows (read from dist/ at runtime)
```

## TypeScript / testing

- ESM (`"type": "module"`); import paths use `.js` extensions in `.ts` sources. Strict TS with `noUncheckedIndexedAccess`. Node ≥ 18.19.
- Unit and integration tests live under `src/__tests__/` (Vitest); E2E specs under `e2e/` with per-provider configs.

## Debugging

- `logging.debug: true` in `~/.takt/config.yaml` → debug logs under `.takt/runs/debug-{timestamp}/logs/`. `TAKT_VERBOSE=true` for verbose console. Session logs at `.takt/logs/{sessionId}.jsonl`.
- OpenCode's composed system prompt cannot be read from the binary or SDK; `tools/opencode-probe/sdk-prompt-capture.mjs` points OpenCode at a local OpenAI-compatible probe endpoint and records real request bodies. Facts established with it (re-verify — OpenCode changes): the system prompt concatenates `agent.prompt` + the user's `~/.claude/CLAUDE.md` + skills + `config.instructions`; every prompt triggers a thread-title call on `small_model` before the real one (capture tooling that grabs the first request measures the title generator). Do not use `opencode run` (CLI) as a measurement instrument — it intermittently hangs; production uses `createOpencode` from the SDK.

## House conventions (from AGENTS.md / CONTRIBUTING.md)

- Prefer simple code over defensive fallback-heavy logic. TAKT is a local tool: no audit trails, tamper-resistance, or security theater — the threat model is provider output and engine wiring mistakes, not hostile users editing their own files.
- Filenames mostly `kebab-case`. Conventional Commit style with occasional `(#issue)` suffix.
- Don't commit secrets; provider keys live in env vars or `~/.takt/config.yaml`.
- A TAKT review pass is recommended before a PR: `takt -t "#<PR>" -w review-takt-default`. For CodeRabbit comments: judge each, act on the valid ones, resolve every thread; don't post replies.
