# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is not user-facing documentation.** It exists for Claude Code to read while working in the repository — it does not substitute for the real docs under `docs/` or `README.md`. Content being recorded here NEVER implies "we don't need to write this up for users." Anything users should see must still be added to `README.md` / `docs/**` separately.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration CLI. It runs AI agents (Claude, Codex, OpenCode, Cursor, Copilot) through YAML-defined workflows: a state machine of steps with rule-based routing, parallel review sub-steps, dynamic task decomposition, and worktree-isolated execution. TAKT is dogfooded — this repository uses TAKT itself for review and development.

## Development Commands

| Command | Notes |
|---------|-------|
| `npm run build` | `tsc` plus copy of `src/shared/prompts/{en,ja}/*.md`, `src/shared/i18n/*.yaml`, and `src/core/runtime/presets/*.sh` into `dist/`. Skipping any of these copies breaks runtime resolution. |
| `npm run watch` | TypeScript incremental build (no asset copy). |
| `npm run lint` | ESLint on `src/`. `no-explicit-any` is error; unused vars must be prefixed `_`. |
| `npm test` | Vitest unit suite under `src/__tests__/**/*.test.ts`. Single-thread, 15 s timeout, 5 s teardown — tests are not parallelism-safe. |
| `npx vitest run src/__tests__/<file>.test.ts` | Run a single file. |
| `npx vitest run -t "<pattern>"` | Run tests whose name matches `<pattern>`. |
| `npm run test:e2e:mock` | E2E against the `mock` provider (`vitest.config.e2e.mock.ts`, 240 s timeout). Required when touching execution flow, CLI behavior, workflows, or config loading. |
| `npm run test:e2e` | Wrapper around `test:e2e:mock` that also fails on `error connecting to api.github.com` in the output and emits a macOS notification. |
| `npm run test:e2e:provider:{claude,claude-sdk,codex,opencode,cursor}` | E2E against a real provider (slow, costs API credits). |
| `npm run check:release` | Full pre-release gate: `build` + `lint` + `test` + `test:e2e:all`. Used in `.takt/config.yaml` quality_gates. |

### Local quality gates

`.takt/config.yaml` overrides the `implement`, `fix`, and `ai_fix` step gates to require `npm run build`, `npm run lint`, `npm test`, and `npm run test:e2e:mock` to pass before a TAKT step can complete. Run those four locally before pushing — the review workflow will block on them.

## CLI Surface

Entry point: `bin/takt` → `dist/app/cli/index.js` (`src/app/cli/index.ts`). Subcommand definitions live in `src/app/cli/commands.ts`; argumentless/slash-fallback routing is in `src/app/cli/routing.ts`.

Most-used subcommands: `takt` (interactive planning), `takt {task}` (one-shot), `takt run` / `takt watch`, `takt add [task]`, `takt list`, `takt #N` (GitHub issue), `takt workflow {init,doctor}`, `takt eject [--global]`, `takt prompt`, `takt catalog`, `takt repertoire {add,remove,list}`, `takt export-cc` / `export-codex`. See `src/app/cli/commands.ts` for the full list and option flags rather than maintaining a copy here.

Two execution modes share the same engine:

- **Interactive** (`src/features/interactive/`): four sub-modes — `assistant` (default), `passthrough`, `quiet`, `persona`. `/go` executes, `/cancel` aborts.
- **Pipeline** (`src/features/pipeline/`, `--pipeline`): non-interactive. Auto-branch, commit, push; `--auto-pr` for PR creation; `--skip-git` for workflow-only.

## Architecture

### Layered layout (`src/`)

```
app/cli/        CLI entrypoint, command wiring, routing
core/           Engine internals — no IO providers here
  workflow/    Engine, step executors, rule evaluation, instruction builder
  config/      Workflow/global/project config models
  models/      Shared domain types + Zod schemas
  runtime/     Runtime environment & shell presets
  logging/     Structured logging
features/      User-facing feature modules (interactive, pipeline, tasks,
              catalog, prompt, repertoire, analytics, workflowAuthoring,
              workflowSelection)
infra/        Adapters — providers, fs, git/github/gitlab, observability,
              rate-limit, resources, config loaders
shared/       Constants, i18n, ui, utils, prompt templates
agents/       agent-usecases (executeAgent, generateReport, judgeStatus, etc.)
```

Public programmatic API is re-exported from `src/index.ts`.

### Workflow execution

`WorkflowEngine` (`src/core/workflow/engine/WorkflowEngine.ts`) is an EventEmitter-driven state machine. For each step it dispatches to one of four runners under `src/core/workflow/engine/`:

| Runner | When | Notes |
|---|---|---|
| `StepExecutor` | Normal step | 3-phase execution model. |
| `ParallelRunner` | `parallel:` block | `Promise.allSettled()` over sub-steps; parent aggregates with `all()`/`any()`. |
| `ArpeggioRunner` | `arpeggio:` block | Data-driven batch (CSV/JSON → template → LLM) with bounded concurrency. |
| `TeamLeaderRunner` | `team_leader:` block | Leader decomposes the task into parts at runtime, dispatches each to a worker agent. |
| `WorkflowCallExecutor` | `workflow_call:` block | Invokes a subworkflow in the same run; parent rules consume the child outcome. |

Engine emits: `step:start`, `step:complete`, `step:blocked`, `step:report`, `step:user_input`, `step:loop_detected`, `step:cycle_detected`, `phase:start`, `phase:complete`, `workflow:complete`, `workflow:abort`, `iteration:limit`. `LoopDetector` catches consecutive same-step repeats; `CycleDetector` + `loop_monitors` catch cyclic patterns (e.g. `review ↔ fix`).

### Three-phase step model

Each normal step runs up to three phases on the same provider session (resumed across phases):

| Phase | Purpose | Tool set | When |
|---|---|---|---|
| 1 | Main work | Step's `allowed_tools` (`Write` excluded if a report is defined) | Always |
| 2 | Report output | `Write` only | If `output_contracts` is defined |
| 3 | Status judgment | None (judgment only) | If the step has tag-based rules |

Implemented in `src/core/workflow/phase-runner.ts` / `report-phase-runner.ts` / `status-judgment-phase.ts`.

### Rule evaluation (5-stage fallback)

`src/core/workflow/evaluation/` — first match wins, in this order:

1. **Aggregate** — `all("…")` / `any("…")` for parallel parents
2. **Phase 3 tag** — `[STEP:N]` emitted during status judgment
3. **Phase 1 tag** — `[STEP:N]` emitted during main work (fallback)
4. **AI judge** — `ai("…")` conditions evaluated by the provider
5. **AI judge fallback** — provider evaluates every condition as a last resort

Quirks that matter:

- Tag rules match by array **index** (0-based), not by condition text.
- When multiple `[STEP:N]` tags appear, **last match wins**.
- If rules exist but nothing matches, the workflow **fails fast** (abort) — silently picking a default is a bug.

### Instruction assembly

`InstructionBuilder` (`src/core/workflow/instruction/`) auto-injects execution context, workflow context, `{task}`, `{previous_response}`, `{user_inputs}`, and status output rules into every instruction. **Templates should contain only step-specific content** — don't repeat boilerplate the builder already adds.

### Provider integration

`src/infra/providers/` exposes a unified `Provider` interface (`setup(AgentSetup) → ProviderAgent`, `ProviderAgent.call(prompt, options) → AgentResponse`). Registered providers: `claude-sdk` (Anthropic Agent SDK), `claude` (headless CLI, `src/infra/claude-headless/`), `codex` (`@openai/codex-sdk`), `opencode` (`@opencode-ai/sdk`, shared server pool), `cursor`, `copilot`, `mock`.

**Provider errors must surface through `AgentResponse.error`.** If they don't, SDK failures appear as empty `blocked` status and are nearly impossible to debug.

**Model/provider resolution priority** (highest first):

1. Step `promotion` entry that matches current execution count or `ai()` condition
2. Step `provider` / `model`
3. Persona-level `persona_providers.<persona>`
4. CLI/task override (`--provider` / `--model`)
5. `.takt/config.yaml` then `~/.takt/config.yaml` (when provider matches)
6. Provider default

`promotion` is **not** supported on parallel sub-steps.

### Config & workflow loading

`src/infra/config/loaders/`. Workflow resolution is **3-layer with project taking priority**: `.takt/workflows/` → `~/.takt/workflows/` → bundled `builtins/{lang}/workflows/`. Repertoire packages use `@{owner}/{repo}/{workflow-name}`. YAML parsing + step/rule normalization runs through Zod schemas in `src/core/models/schemas.ts`.

### Worktree-isolated execution

When a task sets `worktree: true`, TAKT runs it in a `git clone --shared` (lightweight clone with its own `.git`), not a real git worktree. The field name is retained for back-compat; the implementation uses `git clone` because Claude Code follows `.git`-file `gitdir:` pointers back to the main repo, which breaks isolation.

- Clones are ephemeral: created pre-run, auto-committed + pushed on success, deleted afterward.
- Sessions can't be resumed inside the clone (`cwd !== projectCwd`); session resume is skipped there.
- Clones contain only tracked files — no `node_modules`. Runtime presets under `src/core/runtime/presets/` handle setup.
- `cwd` = clone path, `projectCwd` = repo root; reports go to `cwd/.takt/runs/{slug}/reports/`.

## Faceted Prompting

Prompts are split into four facet kinds — keep additions in the right bucket or reviewers will lose track:

| Facet | Lives in | Holds |
|---|---|---|
| `personas/` | `builtins/{lang}/facets/personas/` | WHO — identity, expertise, behavioral habits. Must be reusable across workflows; never put workflow-specific procedures here. |
| `policies/` | `builtins/{lang}/facets/policies/` | HOW — REJECT/APPROVE criteria. **Reviewers only enforce what's in policy**; knowledge alone does not trigger enforcement. |
| `knowledge/` | `builtins/{lang}/facets/knowledge/` | WHAT TO KNOW — domain patterns, anti-patterns, examples, reasoning. |
| `instructions/` | `builtins/{lang}/facets/instructions/` | WHAT TO DO NOW — step-bound procedures and checklists. |

Output contracts live under `builtins/{lang}/facets/output-contracts/`. User overrides go under `~/.takt/facets/<type>/` or `.takt/facets/<type>/`.

## Runtime directory layout

```
~/.takt/                Global user config
  config.yaml           provider / model / language / log level
  workflows/            user workflow overrides
  facets/               user facets (personas/, policies/, knowledge/, instructions/, output-contracts/)
  repertoire/           installed @{owner}/{repo}/ packages

.takt/                  Project config (highest priority)
  config.yaml           project overrides (quality_gates, workflow_overrides, etc.)
  workflows/, facets/   project-level overrides
  tasks.yaml, tasks/    queued task specs
  runs/{slug}/reports/  per-run reports
  logs/                 NDJSON session logs (gitignored)
  events/               analytics events (NDJSON)

builtins/               Bundled defaults (read from dist/ at runtime)
  {en,ja}/              language-scoped facets + workflows
  project/              project-template assets
  schemas/              JSON schemas
  skill/, skill-codex/  exported Claude Code / Codex skill bundles
```

## TypeScript / testing

- ESM (`"type": "module"`). Import paths use `.js` extensions in `.ts` sources.
- Strict TS with `noUncheckedIndexedAccess`. Node ≥ 18.19.
- Zod v4 for runtime schemas (`src/core/models/schemas.ts`).
- Unit tests under `src/__tests__/` (Vitest, single-thread). E2E specs under `e2e/`, with one vitest config per provider (`vitest.config.e2e.*.ts`).
- `src/__tests__/test-setup.ts` clears `TAKT_CONFIG_DIR` and `TAKT_NOTIFY_WEBHOOK` per test — don't rely on inherited env in tests.

## Debugging

- Set `logging.debug: true` in `~/.takt/config.yaml` for debug logs under `.takt/runs/debug-{timestamp}/logs/`.
- `TAKT_VERBOSE=true` or `verbose: true` for verbose console output.
- Session logs at `.takt/logs/{sessionId}.jsonl`.
- Use `--provider mock` to exercise the engine without calling a real API.

## House conventions (from AGENTS.md / CONTRIBUTING.md)

- Prefer simple code over defensive fallback-heavy logic.
- Filenames mostly `kebab-case`, focused module names like `workflowLoader.ts`.
- Conventional Commit style with occasional `(#issue)` suffix.
- Don't commit secrets; provider keys live in env vars or `~/.takt/config.yaml`.
- PRs need a TAKT review pass: `takt -t "#<PR>" -w review` (or branch/current-diff variants). Paste `.takt/runs/*/reports/review-summary.md` into the PR — maintainers gate on it.
