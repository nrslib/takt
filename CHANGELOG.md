# Changelog

[日本語](./docs/CHANGELOG.ja.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.20.0] - 2026-02-19

### Added

- **Faceted Prompting module** (`src/faceted-prompting/`): Standalone library for facet composition, resolution, template rendering, and truncation — zero dependencies on TAKT internals. Includes `DataEngine` interface with `FileDataEngine` and `CompositeDataEngine` implementations for pluggable facet storage
- **Analytics module** (`src/features/analytics/`): Local-only review quality metrics collection — event types (review findings, fix actions, movement results), JSONL writer with date-based rotation, report parser, and metrics computation
- **`takt metrics review` command**: Display review quality metrics (re-report counts, round-trip ratio, resolution iterations, REJECT counts by rule, rebuttal resolution ratio) with configurable time window (`--since`)
- **`takt purge` command**: Purge old analytics event files with configurable retention period (`--retention-days`)
- **`takt reset config` command**: Reset global config to builtin template with automatic backup of the existing config
- **PR duplicate prevention**: When a PR already exists for the current branch, push and comment on the existing PR instead of creating a duplicate (#304)
- Retry mode now positions the cursor on the failed movement when selecting which movement to retry
- E2E tests for run-recovery and config-priority scenarios

### Changed

- **README overhaul**: Compressed from ~950 lines to ~270 lines — details split into dedicated docs (`docs/configuration.md`, `docs/cli-reference.md`, `docs/task-management.md`, `docs/ci-cd.md`, `docs/builtin-catalog.md`) with Japanese equivalents. Redefined product concept around 4 value axes: batteries included, practical, reproducible, multi-agent
- **Config system refactored**: Unified configuration resolution to `resolveConfigValue()` and `loadConfig()`, eliminating scattered config access patterns across the codebase
- **`takt config` command removed**: Replaced by `takt reset config` for resetting to defaults
- Builtin config templates refreshed with updated comments and structure
- `@anthropic-ai/claude-agent-sdk` updated to v0.2.47
- Instruct mode prompt improvements for task re-instruction

### Fixed

- Fixed issue where builtin piece file references used absolute path instead of relative (#304)
- Removed unused imports and variables across multiple files

### Internal

- Unified `loadConfig`, `resolveConfigValue`, piece config resolution, and config priority paths
- Added E2E tests for config priority and run recovery scenarios
- Added `postExecution.test.ts` for PR creation flow testing
- Cleaned up unused imports and variables

## [0.19.0] - 2026-02-18

### Added

- Dedicated retry mode for failed tasks — conversation loop with failure context (error details, failed movement, last message), run session data, and piece structure injected into the system prompt
- Dedicated instruct system prompt for completed/failed task re-instruction — injects task name, content, branch changes, and retry notes directly into the prompt instead of using the generic interactive prompt
- Direct re-execution from `takt list` — "execute" action now runs the task immediately in the existing worktree instead of only requeuing to pending
- `startReExecution` atomic task transition — moves a completed/failed task directly to running status, avoiding the requeue → claim race condition
- Worktree reuse in task execution — reuses existing clone directory when it's still on disk, skipping branch name generation and clone creation
- Task history injection into interactive and summary system prompts — completed/failed/interrupted task summaries are included for context
- Previous run reference support in interactive and instruct system prompts — users can reference logs and reports from prior runs
- `findRunForTask` and `getRunPaths` helpers for automatic run session lookup by task content
- `isStaleRunningTask` process helper extracted from TaskLifecycleService for reuse

### Changed

- Interactive module split: `interactive.ts` refactored into `interactive-summary.ts`, `runSelector.ts`, `runSessionReader.ts`, and `selectorUtils.ts` for better cohesion
- `requeueTask` now accepts generic `allowedStatuses` parameter instead of only accepting `failed` tasks
- Instruct/retry actions in `takt list` use the worktree path for conversation and run data lookup instead of the project root
- `save_task` action now requeues the task (saves for later execution), while `execute` action runs immediately

### Internal

- Removed `DebugConfig` from models, schemas, and global config — simplified to verbose mode only
- Added stdin simulation test helpers (`stdinSimulator.ts`) for E2E conversation loop testing
- Added comprehensive E2E tests for retry mode, interactive routes, and run session injection
- Added `check:release` npm script for pre-release validation

## [0.18.2] - 2026-02-18

### Added

- Added `codex_cli_path` global config option and `TAKT_CODEX_CLI_PATH` environment variable to override the Codex CLI binary path used by the Codex SDK (#292)
  - Supports strict validation: absolute path, file existence, executable permission, no control characters
  - Priority: `TAKT_CODEX_CLI_PATH` env var > `codex_cli_path` in config.yaml > SDK vendored binary

## [0.18.1] - 2026-02-18

### Added

- Added multi-tenant data isolation section and authorization-resolver consistency code examples to security knowledge
- Added "prefer project scripts" rule to coding policy — detects direct tool invocation (e.g., `npx vitest`) when equivalent npm scripts exist

## [0.18.0] - 2026-02-17

### Added

- **`deep-research` builtin piece**: Multi-angle research workflow with four steps — plan, deep-dive, analyze, and synthesize
- Project-level `.takt/` facets (pieces, personas, policies, knowledge, instructions, output-contracts) are now version-controllable (#286)
- New research facets added: research policy, knowledge, comparative-analysis knowledge, dedicated persona, and instructions

### Changed

- Refactored the `research` piece — separated rules and knowledge embedded in the persona into policy, knowledge, and instruction files, conforming to the faceted design
- Added knowledge/policy references to existing pieces (expert, expert-cqrs, backend, backend-cqrs, frontend)

### Fixed

- Fixed a bug where facet directories were not tracked because `.takt/` path prefix was written with `.takt/` prefix in the `.takt/.gitignore` template (dotgitignore)

### Internal

- Created knowledge facet style guide (`KNOWLEDGE_STYLE_GUIDE.md`)
- Added regression tests for dotgitignore patterns

## [0.17.3] - 2026-02-16

### Added

- Added API client generation consistency rules to builtin AI anti-pattern policy and frontend knowledge — detects handwritten clients mixed into projects where generation tools (e.g., Orval) exist

### Fixed

- Fixed EPERM crash when releasing task store locks — replaced file-based locking with in-memory guard

### Internal

- Unified vitest configuration for e2e tests and added `forceExit` option to prevent zombie workers

## [0.17.2] - 2026-02-15

### Added

- **`expert-mini` and `expert-cqrs-mini` pieces**: Lightweight variants of Expert pieces — plan → implement → parallel review (AI anti-pattern + supervisor) → fix workflow
- Added new pieces to "Mini" and "Expert" piece categories

### Fixed

- Fixed an error being thrown when permission mode could not be resolved — now falls back to `readonly`

## [0.17.1] - 2026-02-15

### Changed

- Changed `.takt/.gitignore` template to allowlist approach — ignores all files by default and tracks only `config.yaml`. Prevents ignore gaps when new files are added

## [0.17.0] - 2026-02-15

### Added

- **Mini piece series**: Added `default-mini`, `frontend-mini`, `backend-mini`, `backend-cqrs-mini` — lightweight development pieces with parallel review (AI anti-pattern + supervisor) as successors to `coding`/`minimal`
- Added "Mini" category to piece categories
- **`supervisor-validation` output contract**: Requirements Fulfillment Check table format that presents code evidence per requirement
- **`getJudgmentReportFiles()`**: Phase 3 status judgment target reports can now be filtered via `use_judge` flag
- Added `finding_id` tracking to output contracts (new/persists/resolved sections for tracking findings across iterations)

### Changed

- **BREAKING: Removed `coding` and `minimal` pieces** — replaced by the mini piece series. Migration: `coding` → `default-mini`, `minimal` → `default-mini`
- **BREAKING: Unified output contract to item format** — `use_judge` (boolean) and `format` (string) fields are now required; `OutputContractLabelPath` (label:path format) is removed
- Moved runtime environment directory from `.runtime` to `.takt/.runtime`
- Enhanced supervisor requirements verification: extracts requirements individually and verifies one-by-one against code (file:line) — "roughly complete" is no longer valid grounds for APPROVE

### Fixed

- Added retry mechanism for deleting clone/worktree directories (`maxRetries: 3`, `retryDelay: 200`) — reduces transient deletion failures caused by file locks

### Internal

- Removed `review-summary` output contract (consolidated into `supervisor-validation`)
- Updated all builtin pieces, e2e fixtures, and tests to the new output contract format

## [0.16.0] - 2026-02-15

### Added

- **Provider-specific permission profiles (`provider_profiles`)**: Define default permission modes per provider and per-movement overrides in global (`~/.takt/config.yaml`) and project (`.takt/config.yaml`) config — 5-level priority resolution (project override → global override → project default → global default → `required_permission_mode` floor)

### Changed

- **BREAKING: `permission_mode` → `required_permission_mode`**: Renamed movement's `permission_mode` field to `required_permission_mode` — acts as a floor value; the actual permission mode is resolved via `provider_profiles`. Old `permission_mode` is rejected by `z.never()`, no backward compatibility
- Rewrote builtin `config.yaml` template: reorganized comments, added `provider_profiles` description and examples, added OpenCode-related settings

### Internal

- Added tests for provider profile resolution (global-provider-profiles, project-provider-profiles, permission-profile-resolution, options-builder)
- Added missing `loadProjectConfig` mock to parallel execution tests

## [0.15.0] - 2026-02-15

### Added

- **Runtime environment presets**: `piece_config.runtime.prepare` and global config `runtime.prepare` allow environment preparation scripts to run automatically before piece execution — builtin presets (`gradle`, `node`) isolate dependency resolution and cache setup to the `.runtime/` directory
- **Loop monitor judge instruction**: `loop_monitors` judge config now supports `instruction_template` field — externalizes loop judgment instructions as an instruction facet, applied to builtin pieces (expert, expert-cqrs)

### Internal

- Added runtime environment tests (runtime-environment, globalConfig-defaults, models, provider-options-piece-parser)
- Added provider e2e test (runtime-config-provider)

## [0.14.0] - 2026-02-14

### Added

- **`takt list` instruct mode (#267)**: Added instruct mode for issuing additional instructions to existing branches — refine requirements through a conversation loop before piece execution
- **`takt list` completed task actions (#271)**: Added diff view and branch operations (merge, delete) for completed tasks
- **Claude sandbox configuration**: `provider_options.claude.sandbox` supports `excluded_commands` and `allow_unsandboxed_commands`
- **`provider_options` global/project config**: `provider_options` can now be set in `~/.takt/config.yaml` (global) and `.takt/config.yaml` (project) — acts as lowest-priority fallback for piece-level settings

### Changed

- **Consolidated provider/model resolution into AgentRunner**: Fixed provider resolution to prioritize project config over custom agent config. Added step-level `stepModel`/`stepProvider` overrides
- **Unified post-execution flow**: Shared `postExecution.ts` for interactive mode and instruct mode (auto-commit, push, PR creation)
- **Added scope-narrowing prevention to instructions**: plan, ai-review, and supervise instructions now require detecting missed requirements — plan mandates per-requirement "change needed/not needed" judgments with rationale, supervise prohibits blindly trusting plan reports

### Fixed

- Fixed a bug where interactive mode options were displayed during async execution (#266)
- Fixed OpenCode session ID not being carried over during parallel execution — server singleton prevents race conditions in parallel runs
- Extended OpenCode SDK server startup timeout from 30 seconds to 60 seconds

### Internal

- Large-scale task management refactor: split `TaskRunner` responsibilities into `TaskLifecycleService`, `TaskDeletionService`, and `TaskQueryService`
- Split `taskActions.ts` by feature: `taskBranchLifecycleActions.ts`, `taskDiffActions.ts`, `taskInstructionActions.ts`, `taskDeleteActions.ts`
- Added `postExecution.ts`, `taskResultHandler.ts`, `instructMode.ts`, `taskActionTarget.ts`
- Consolidated piece selection logic into `pieceSelection/index.ts` (extracted from `selectAndExecute.ts`)
- Added/expanded tests: instructMode, listNonInteractive-completedActions, listTasksInteractiveStatusActions, option-resolution-order, taskInstructionActions, selectAndExecute-autoPr, etc.
- Added Claude Code sandbox option (`dangerouslyDisableSandbox`) to E2E tests
- Added `OPENCODE_CONFIG_CONTENT` to `.gitignore`

## [0.13.0] - 2026-02-13

### Added

- **Team Leader movement**: New movement type where a team leader agent dynamically decomposes a task into sub-tasks (Parts) and executes multiple part agents in parallel — supports `team_leader` config (persona, maxParts, timeoutMs, partPersona, partEdit, partPermissionMode) (#244)
- **Structured Output**: Introduced JSON Schema-based structured output for agent calls — three schemas for task decomposition, rule evaluation, and status judgment added to `builtins/schemas/`. Supported by both Claude and Codex providers (#257)
- **`provider_options` piece-level config**: Provider-specific options (`codex.network_access`, `opencode.network_access`) can now be set at piece level (`piece_config.provider_options`) and individual movements — Codex/OpenCode network access enabled in all builtin pieces
- **`backend` builtin piece**: New backend development piece — parallel specialist review by backend, security, and QA reviewers
- **`backend-cqrs` builtin piece**: New CQRS+ES backend development piece — parallel specialist review by CQRS+ES, security, and QA reviewers
- **AbortSignal for part timeouts**: Added timeout control and parent signal propagation via AbortSignal for Team Leader part execution
- **Agent usecase layer**: `agent-usecases.ts` consolidates agent call usecases (`decomposeTask`, `executeAgent`, `evaluateRules`) and centralizes structured output injection

### Changed

- **BREAKING: Public API cleanup**: Significantly narrowed the public API in `src/index.ts` — internal implementation details (session management, Claude/Codex client internals, utility functions, etc.) are no longer exported, reducing the API surface to a stable minimum (#257)
- **Revamped Phase 3 judgment logic**: Removed `JudgmentDetector`/`FallbackStrategy` and consolidated into `status-judgment-phase.ts` with structured output-based judgment. Improves stability and maintainability (#257)
- **Report phase retry improvement**: Report Phase (Phase 2) now automatically retries with a new session when it fails (#245)
- **Unified Ctrl+C shutdown**: Removed `sigintHandler.ts` and consolidated into `ShutdownManager` — graceful shutdown → timeout → force-kill in three stages, unified across all providers (#237)
- **Scope-deletion guardrails**: Added rules to coder persona prohibiting deletions and structural changes outside the task instruction scope. Added scope discipline and reference material priority rules to planner persona
- Added design token and theme scope guidance to frontend knowledge
- Improved architecture knowledge (both en/ja)

### Fixed

- Fixed checkout failure for existing branches during clone — now passes `--branch` to `git clone --shared` then removes the remote
- Removed `#` from issue-referenced branch names (`takt/#N/slug` → `takt/N/slug`)
- Resolved deprecated tool dependency in OpenCode report phase; migrated to permission-based control (#246)
- Removed unnecessary exports to ensure public API consistency

### Internal

- Added Team Leader tests (engine-team-leader, team-leader-schema-loader, task-decomposer)
- Added structured output tests (parseStructuredOutput, claude-executor-structured-output, codex-structured-output, provider-structured-output, structured-output E2E)
- Added unit tests for ShutdownManager
- Added unit tests for AbortSignal (abort-signal, claude-executor-abort-signal, claude-provider-abort-signal)
- Added unit tests for Report Phase retry (report-phase-retry)
- Added unit tests for public API exports (public-api-exports)
- Added tests for provider_options (provider-options-piece-parser, models, opencode-types)
- Significantly expanded E2E tests: cycle-detection, model-override, multi-step-sequential, pipeline-local-repo, report-file-output, run-sigint-graceful, session-log, structured-output, task-status-persistence
- Refactored E2E test helpers (extracted shared setup functions)
- Removed `judgment/` directory (JudgmentDetector, FallbackStrategy)
- Added `ruleIndex.ts` utility (1-based → 0-based index conversion)

## [0.12.1] - 2026-02-11

### Fixed

- Fixed silent fallthrough to a new session when the session was not found — now shows an info message when no session is detected

### Internal

- Set OpenCode provider report phase to deny (prevents unnecessary writes in Phase 2)
- Skip copying `tasks/` directory during project initialization (TASK-FORMAT is no longer needed)
- Added stream diagnostics utility (`streamDiagnostics.ts`)

## [0.12.0] - 2026-02-11

### Added

- **OpenCode provider**: Native support for OpenCode as a third provider — SDK integration via `@opencode-ai/sdk/v2`, permission mapping (readonly/edit/full → reject/once/always), SSE stream handling, retry mechanism (up to 3 times), and hang detection with 10-minute timeout (#236, #238)
- **Arpeggio movement**: New movement type for data-driven batch processing — CSV data source with batch splitting, template expansion (`{line:N}`, `{col:N:name}`, `{batch_index}`), concurrent LLM calls (Semaphore-controlled), and concat/custom merge strategies (#200)
- **`frontend` builtin piece**: Frontend development piece — React/Next.js knowledge injection, coding/testing policy, parallel architecture review
- **Slack Webhook notifications**: Automatic Slack notification on piece completion — configured via `TAKT_NOTIFY_WEBHOOK` env var, 10-second timeout, non-blocking on failure (#234)
- **Session selector UI**: On interactive mode startup, select a resumable session from past Claude Code sessions — shows latest 10 sessions with initial input and last response preview (#180)
- **Provider event logs**: Claude/Codex/OpenCode execution events written to NDJSON files — `.takt/logs/{sessionId}-provider-events.jsonl`, with automatic compression of large text (#236)
- **Provider/model name display**: Active provider and model name shown in console output at each movement execution

### Changed

- **Revamped `takt add`**: Auto-add to task on issue selection, removed interactive mode, added task stacking confirmation on issue creation (#193, #194)
- **`max_iteration` → `max_movement` unification**: Unified terminology for iteration limits; added `ostinato` for unlimited execution (#212)
- **Improved `previous_response` injection**: Implemented length control and always-inject Source Path (#207)
- **Task management improvements**: Redefined `.takt/tasks/` as storage for long-form task specs; `completeTask()` removes completed records from `tasks.yaml` (#201, #204)
- **Improved review output**: Updated review output format; moved past reports to history log (#209)
- **Simplified builtin pieces**: Further streamlined top-level declarations across all builtin pieces

### Fixed

- **Fixed Report Phase blocked behavior**: Report Phase (Phase 2) now retries with a new session when blocked (#163)
- **Fixed OpenCode hang and termination detection**: Suppressed prompt echo, suppressed question prompts, fixed hang issues, corrected termination detection (#238)
- **Fixed OpenCode permission and tool wiring**: Corrected permission and tool wiring during edit execution
- **Worktree task spec copy**: Fixed task spec not being correctly copied during worktree execution
- Fixed lint errors (merge/resolveTask/confirm)

### Internal

- Comprehensive OpenCode provider tests added (client-cleanup, config, provider, stream-handler, types)
- Comprehensive Arpeggio tests added (csv, data-source-factory, merge, schema, template, engine-arpeggio)
- Significantly expanded E2E tests: cli-catalog, cli-clear, cli-config, cli-export-cc, cli-help, cli-prompt, cli-reset-categories, cli-switch, error-handling, piece-error-handling, provider-error, quiet-mode, run-multiple-tasks, task-content-file (#192, #198)
- Added `providerEventLogger.ts`, `providerModel.ts`, `slackWebhook.ts`, `session-reader.ts`, `sessionSelector.ts`, `provider-resolution.ts`, `run-paths.ts`
- Added `ArpeggioRunner.ts` (data-driven batch processing engine)
- AI Judge now routes through provider system (Codex/OpenCode support)
- Added/expanded tests: report-phase-blocked, phase-runner-report-history, judgment-fallback, pieceExecution-session-loading, globalConfig-defaults, session-reader, sessionSelector, slackWebhook, providerEventLogger, provider-model, interactive, run-paths, engine-test-helpers

## [0.11.1] - 2026-02-10

### Fixed

- Fixed AI Judge to route through provider system — changed `callAiJudge` from a Claude-only implementation to provider-based (`runAgent`), enabling correct AI judgment with the Codex provider
- Reduced instruction bloat — set `pass_previous_response: false` in implement/fix movements, prioritizing reports in the Report Directory as primary information source (en/ja)

### Internal

- Improved CI workflow to automatically sync npm `next` dist-tag to `latest` on stable releases (with retry)

## [0.11.0] - 2026-02-10

### Added

- **`e2e-test` builtin piece**: E2E test focused piece — E2E analysis → E2E implementation → review → fix flow (for Vitest-based E2E tests)
- **`error` status**: Separated provider errors from `blocked`, enabling clear distinction of error states. Added retry mechanism to Codex
- **Centralized task YAML management**: Unified task file management into `tasks.yaml`. Structured task lifecycle management (pending/running/completed/failed) via `TaskRecordSchema`
- **Task spec documentation**: Documented the structure and purpose of task specs (#174)
- **Review policy**: Added shared review policy facet (`builtins/{lang}/policies/review.md`)
- **SIGINT graceful shutdown E2E test**: E2E test to verify Ctrl+C behavior during parallel execution

### Changed

- **Simplified builtin pieces**: Removed top-level `policies`/`personas`/`knowledge`/`instructions`/`report_formats` declarations from all builtin pieces, migrating to implicit name-based resolution. Piece YAML is now simpler
- **Updated piece category spec**: Improved category configuration and display logic. Enhanced category management in global config (#184)
- **Improved `takt list` priority and resolution**: Optimized branch resolution performance. Introduced base commit cache (#186, #195, #196)
- **Improved Ctrl+C signal handling**: Stabilized SIGINT handling during parallel execution
- **Strengthened loop prevention policy**: Enhanced policy to prevent agent infinite loops

### Fixed

- Fixed original instruction diff processing not working correctly (#181)
- Fixed task spec goal being inappropriately scope-expanded — goal is now always fixed to implementation and execution

### Internal

- Large-scale task management refactor: removed `parser.ts` and split into `store.ts`/`mapper.ts`/`schema.ts`/`naming.ts`. Split branch resolution into `branchGitResolver.ts`/`branchBaseCandidateResolver.ts`/`branchBaseRefCache.ts`/`branchEntryPointResolver.ts`
- Significantly expanded and refactored tests: added aggregate-evaluator, blocked-handler, branchGitResolver-performance, branchList-regression, buildListItems-performance, error-utils, escape, facet-resolution, getFilesChanged, global-pieceCategories, instruction-context, instruction-helpers, judgment-strategies, listTasksInteractivePendingLabel, loop-detector, naming, reportDir, resetCategories, rule-evaluator, rule-utils, slug, state-manager, switchPiece, task-schema, text, transitions, watchTasks, etc.
- Refactored Codex client
- Improved facet resolution logic in piece parser

## [0.10.0] - 2026-02-09

### Added

- **`structural-reform` builtin piece**: Full project review and structural reform — iterative codebase restructuring with staged file splits, powered by `loop_monitors`
- **`unit-test` builtin piece**: Unit test focused piece — test analysis → test implementation → review → fix, with `loop_monitors` for cycle control
- **`test-planner` persona**: Specialized persona for analyzing codebase and planning comprehensive test strategies
- **Interactive mode variants**: Four selectable modes after piece selection — `assistant` (default: AI-guided requirement refinement), `persona` (conversation with first movement's persona), `quiet` (generate instructions without questions), `passthrough` (user input used as-is)
- **`persona_providers` config**: Per-persona provider overrides (e.g., `{ coder: 'codex' }`) — route specific personas to different providers without creating hybrid pieces
- **`task_poll_interval_ms` config**: Configurable polling interval for `takt run` to detect new tasks during execution (default: 500ms, range: 100–5000ms)
- **`interactive_mode` piece field**: Piece-level default interactive mode override (e.g., set `passthrough` for pieces that don't benefit from AI planning)
- **Task-level output prefixing**: Colored `[taskName]` prefix on all output lines during parallel `takt run` execution, preventing mid-line interleaving between concurrent tasks
- **Review policy facet**: Shared review policy (`builtins/{lang}/policies/review.md`) for consistent review criteria across pieces

### Changed

- **BREAKING:** Removed all Hybrid Codex pieces (`*-hybrid-codex`) — replaced by `persona_providers` config which achieves the same result without duplicating piece files
- Removed `tools/generate-hybrid-codex.mjs` (no longer needed with `persona_providers`)
- Improved parallel execution output: movement-level prefix now includes task context and iteration info in concurrent runs
- Codex client now detects stream hangs (10-minute idle timeout) and distinguishes timeout vs external abort in error messages
- Parallel task execution (`takt run`) now polls for newly added tasks during execution instead of only checking between task completions
- Parallel task execution no longer enforces per-task time limits (previously had a timeout)
- Issue references now routed through interactive mode (as initial input) instead of skipping interactive mode entirely
- Builtin `config.yaml` updated to document all GlobalConfig fields
- Extracted `conversationLoop.ts` for shared conversation logic across interactive mode variants
- Line editor improvements: additional key bindings and edge case fixes

### Fixed

- Codex processes hanging indefinitely when stream becomes idle — now aborted after 10 minutes of inactivity, releasing worker pool slots

### Internal

- New test coverage: engine-persona-providers, interactive-mode (532 lines), task-prefix-writer, workerPool expansion, pieceResolver expansion, lineEditor expansion, parallel-logger expansion, globalConfig-defaults expansion, pieceExecution-debug-prompts expansion, it-piece-loader expansion, runAllTasks-concurrency expansion, engine-parallel
- Extracted `TaskPrefixWriter` for task-level parallel output management
- Extracted `modeSelection.ts`, `passthroughMode.ts`, `personaMode.ts`, `quietMode.ts` from interactive module
- `InteractiveMode` type model added (`src/core/models/interactive-mode.ts`)
- `PieceEngine` validates `taskPrefix`/`taskColorIndex` pair consistency at construction
- Implementation notes document added (`docs/implements/retry-and-session.ja.md`)

## [0.9.0] - 2026-02-08

### Added

- **`takt catalog` command**: List available facets (personas, policies, knowledge, instructions, output-contracts) across layers (builtin/user/project)
- **`compound-eye` builtin piece**: Multi-model review — sends the same instruction to Claude and Codex simultaneously, then synthesizes both responses
- **Parallel task execution**: `takt run` now uses a worker pool for concurrent task execution (controlled by `concurrency` config, default: 1)
- **Rich line editor in interactive mode**: Shift+Enter for multiline input, cursor movement (arrow keys, Home/End), Option+Arrow word movement, Ctrl+A/E/K/U/W editing, paste bracket mode support
- **Movement preview in interactive mode**: Injects piece movement structure (persona + instruction) into the AI planner for improved task analysis (`interactive_preview_movements` config, default: 3)
- **MCP server configuration**: Per-movement MCP (Model Context Protocol) server settings with stdio/SSE/HTTP transport support
- **Facet-level eject**: `takt eject persona coder` — eject individual facets by type and name for customization
- **3-layer facet resolution**: Personas, policies, and other facets resolved via project → user → builtin lookup (name-based references supported)
- **`pr-commenter` persona**: Specialized persona for posting review findings as GitHub PR comments
- **`notification_sound` config**: Enable/disable notification sounds (default: true)
- **Prompt log viewer**: `tools/prompt-log-viewer.html` for visualizing prompt-response pairs during debugging
- Auto-PR base branch now set to the current branch before branch creation

### Changed

- Unified planner and architect-planner: extracted design knowledge into knowledge facets, merged into planner. Removed architect movement from default/coding pieces (plan → implement direct transition)
- Replaced readline with raw-mode line editor in interactive mode (cursor management, inter-line movement, Kitty keyboard protocol)
- Unified interactive mode `save_task` with `takt add` worktree setup flow
- Added `-d` flag to caffeinate to prevent App Nap process freezing during display sleep
- Issue references now routed through interactive mode (previously executed directly, now used as initial input)
- SDK update: `@anthropic-ai/claude-agent-sdk` v0.2.34 → v0.2.37
- Enhanced interactive session scoring prompts with piece structure information

### Internal

- Extracted `resource-resolver.ts` for facet resolution logic (separated from `pieceParser.ts`)
- Extracted `parallelExecution.ts` (worker pool), `resolveTask.ts` (task resolution), `sigintHandler.ts` (shared SIGINT handler)
- Unified session key generation via `session-key.ts`
- New `lineEditor.ts` (raw-mode terminal input, escape sequence parsing, cursor management)
- Extensive test additions: catalog, facet-resolution, eject-facet, lineEditor, formatMovementPreviews, models, debug, strip-ansi, workerPool, runAllTasks-concurrency, session-key, interactive (major expansion), cli-routing-issue-resolve, parallel-logger, engine-parallel-failure, StreamDisplay, getCurrentBranch, globalConfig-defaults, pieceExecution-debug-prompts, selectAndExecute-autoPr, it-notification-sound, it-piece-loader, permission-mode (expansion)

## [0.8.0] - 2026-02-08

Formal release of 0.8.0-alpha.1 content. No functional changes.

## [0.8.0-alpha.1] - 2026-02-07

### Added

- **Faceted Prompting architecture**: Prompt components are managed as independent files and can be freely combined across pieces
  - `personas/` — persona prompts defining agent role and expertise
  - `policies/` — policies defining coding standards, quality criteria, and prohibitions
  - `knowledge/` — knowledge defining domain knowledge and architecture information
  - `instructions/` — instructions defining movement-specific procedures
  - `output-contracts/` — output contracts defining report output formats
  - Piece YAML section maps (`personas:`, `policies:`, `knowledge:`) associate keys with file paths; movements reference by key
- **Output Contracts and Quality Gates**: Structured definitions for report output and AI directives for quality criteria
  - `output_contracts` field defines reports (replaces `report` field)
  - `quality_gates` field specifies AI directives for movement completion requirements
- **Knowledge system**: Separates domain knowledge from personas, managed and injected at piece level
  - `knowledge:` section map in piece YAML defines knowledge files
  - Movements reference by key via `knowledge:` field
- **Faceted Prompting documentation**: Design philosophy and practical guide added to `docs/faceted-prompting.md` (en/ja)
- **Hybrid Codex piece generation tool**: `tools/generate-hybrid-codex.mjs` auto-generates Codex variants from Claude pieces
- Failed task re-queue: select failed task branches from `takt list` and re-execute (#110)
- Branch name generation strategy is now configurable (`branch_name_strategy` config)
- Added auto-PR feature and unified PR creation logic (#98)
- Piece selection now also applies for issue references (#97)
- Sleep functionality added to movements

### Changed

- **BREAKING:** Renamed `resources/global/` directory to `builtins/`
  - `resources/global/{lang}/` → `builtins/{lang}/`
  - Changed `files` field in package.json from `resources/` to `builtins/`
- **BREAKING:** Renamed `agent` field to `persona`
  - Piece YAML: `agent:` → `persona:`, `agent_name:` → `persona_name:`
  - Internal types: `agentPath` → `personaPath`, `agentDisplayName` → `personaDisplayName`, `agentSessions` → `personaSessions`
  - Directories: `agents/` → `personas/` (global, project, and builtin)
- **BREAKING:** Changed `report` field to `output_contracts`
  - Unified legacy `report: 00-plan.md` / `report: [{Scope: ...}]` / `report: {name, order, format}` formats to `output_contracts: {report: [...]}` format
- **BREAKING:** Renamed `stances` → `policies`, `report_formats` → `output_contracts`
- Migrated all builtin pieces to Faceted Prompting architecture (separated domain knowledge from old agent prompts into knowledge facets)
- SDK updates: `@anthropic-ai/claude-agent-sdk` v0.2.19 → v0.2.34, `@openai/codex-sdk` v0.91.0 → v0.98.0
- Added `policy`/`knowledge` fields to movements (referenced by section map keys)
- Added policy-based evaluation to interactive mode scoring
- Refreshed README: agent → persona, added section map description, clarified control/management classification
- Refreshed builtin skill (SKILL.md) for Faceted Prompting

### Fixed

- Fixed report directory path resolution bug
- Fixed PR issue number link not being set correctly
- Fixed gitignored files being committed in `stageAndCommit` (removed `git add -f .takt/reports/`)

### Internal

- Large-scale builtin resource restructuring: removed old `agents/` directory structure (`default/`, `expert/`, `expert-cqrs/`, `magi/`, `research/`, `templates/`) and migrated to flat `personas/`, `policies/`, `knowledge/`, `instructions/`, `output-contracts/` structure
- Added Faceted Prompting style guides and templates (`PERSONA_STYLE_GUIDE.md`, `POLICY_STYLE_GUIDE.md`, `INSTRUCTION_STYLE_GUIDE.md`, `OUTPUT_CONTRACT_STYLE_GUIDE.md`, etc. in `builtins/ja/`)
- Added policy, knowledge, and instruction resolution logic to `pieceParser.ts`
- Added/expanded tests: knowledge, policy-persona, deploySkill, StreamDisplay, globalConfig-defaults, sleep, task, taskExecution, taskRetryActions, addTask, saveTaskFile, parallel-logger, summarize
- Added policy and knowledge content injection to `InstructionBuilder`
- Added `taskRetryActions.ts` (failed task re-queue logic)
- Added `sleep.ts` utility
- Removed old prompt files (`interactive-summary.md`, `interactive-system.md`)
- Removed old agent templates (`templates/coder.md`, `templates/planner.md`, etc.)

## [0.7.1] - 2026-02-06

### Fixed

- Fixed Ctrl+C not working during piece execution: SIGINT handler now calls `interruptAllQueries()` to stop active SDK queries
- Fixed EPIPE crash after Ctrl+C: dual protection for EPIPE errors when SDK writes to stdin of a stopped child process (`uncaughtException` handler + `Promise.resolve().catch()`)
- Fixed terminal raw mode leaking when an exception occurs in the select menu's `onKeypress` handler

### Internal

- Added integration tests for SIGINT handler and EPIPE suppression (`it-sigint-interrupt.test.ts`)
- Added key input safety tests for select menu (`select-rawmode-safety.test.ts`)

## [0.7.0] - 2026-02-06

### Added

- Hybrid Codex pieces: Added Codex variants for all major pieces (default, minimal, expert, expert-cqrs, passthrough, review-fix-minimal, coding)
  - Hybrid configuration running the coder agent on the Codex provider
  - en/ja support
- `passthrough` piece: Minimal piece that passes the task directly to the coder
- `takt export-cc` command: Deploy builtin pieces and agents as Claude Code Skills
- Added delete action to `takt list`, separated non-interactive mode
- AI consultation action: `takt add` / interactive mode can now create GitHub Issues and save task files
- Cycle detection: Added `CycleDetector` to detect infinite loops between ai_review and ai_fix (#102)
  - Added arbitration step (`ai_no_fix`) to the default piece for when no fix is needed
- CI: Added workflow to auto-delete skipped TAKT Action runs weekly
- Added Hybrid Codex subcategory to piece categories (en/ja)

### Changed

- Simplified category configuration: merged `default-categories.yaml` into `piece-categories.yaml`, changed to auto-copy to user directory
- Fixed subcategory navigation in piece selection UI (recursive hierarchical display now works correctly)
- Refreshed Claude Code Skill to Agent Team-based design
- Unified `console.log` to `info()` (list command)

### Fixed

- Fixed YAML parse error caused by colons in Hybrid Codex piece descriptions
- Fixed invalid arguments passed to `selectPieceFromCategoryTree` on subcategory selection

### Internal

- Refactored `list` command: separated `listNonInteractive.ts`, `taskDeleteActions.ts`
- Added `cycle-detector.ts`, integrated cycle detection into `PieceEngine`
- Refactored piece category loader (`pieceCategories.ts`, `pieceSelection/index.ts`)
- Added tests: cycle-detector, engine-loop-monitors, piece-selection, listNonInteractive, taskDeleteActions, createIssue, saveTaskFile

## [0.6.0] - 2026-02-05

Formal release of RC1/RC2 content. No functional changes.

## [0.6.0-rc1] - 2026-02-05

### Fixed

- Fixed infinite loop between ai_review and ai_fix: resolved issue where ai_fix judging "no fix needed" caused a return to plan and restarted the full pipeline
  - Added `ai_no_fix` arbitration step (architecture-reviewer judges the ai_review vs ai_fix conflict)
  - Changed ai_fix "no fix needed" route from `plan` to `ai_no_fix`
  - Affected pieces: default, expert, expert-cqrs (en/ja)

### Changed

- Changed default piece parallel reviewer from security-review to qa-review (optimized for TAKT development)
- Moved qa-reviewer agent from `expert/` to `default/` and rewrote with focus on test coverage
- Added iteration awareness to ai_review instruction (first iteration: comprehensive review; subsequent: prioritize fix verification)

### Internal

- Restricted auto-tag workflow to merges from release/ branches only, unified publish job (resolves chained trigger failure due to GITHUB_TOKEN limitations)
- Removed postversion hook (conflicts with release branch flow)
- Updated tests: adapted to security-reviewer → qa-reviewer change

## [0.6.0-rc] - 2026-02-05

### Added

- **`coding` builtin piece**: Lightweight development piece — design → implement → parallel review → fix (fast feedback loop without plan/supervise steps)
- **`conductor` agent**: Dedicated agent for Phase 3 judgment. Reads reports and responses to output judgment tags
- **Phase 3 judgment fallback strategy**: 4-stage fallback (AutoSelect → ReportBased → ResponseBased → AgentConsult) to improve judgment accuracy (`src/core/piece/judgment/`)
- **Session state management**: Saves task execution results (success/error/interrupted) and displays previous result on next interactive mode startup (#89)
- TAKT meta information (piece structure, progress) injection mechanism for agents
- **`/play` command**: Immediately executes task in interactive mode
- E2E test infrastructure: mock/provider-compatible test infrastructure, 10 E2E test specs, test helpers (isolated-env, takt-runner, test-repo)
- Added detection rule for "logically unreachable defensive code" to review agents

### Changed

- Changed Phase 3 judgment logic from session-resume approach to conductor agent + fallback strategy (improved judgment stability)
- Refactored CLI routing as `executeDefaultAction()` function, reusable as fallback from slash commands (#32)
- Input starting with `/` or `#` is now accepted as task instruction when no command/issue is found (#32)
- Simplified `isDirectTask()`: only issue references execute directly, all others go to interactive mode
- Removed `pass_previous_response: true` from all builtin pieces (redundant as it is the default behavior)

### Internal

- Added E2E test config files (vitest.config.e2e.ts, vitest.config.e2e.mock.ts, vitest.config.e2e.provider.ts)
- Added `getReportFiles()`, `hasOnlyOneBranch()`, `getAutoSelectedTag()` to `rule-utils.ts`
- Added report content and response-based judgment instruction generation to `StatusJudgmentBuilder`
- Added piece meta information (structure, iteration counts) injection to `InstructionBuilder`
- Added tests: judgment-detector, judgment-fallback, sessionState, pieceResolver, cli-slash-hash, e2e-helpers

## [0.5.1] - 2026-02-04

### Fixed

- Windows environment file path handling and encoding issues (#90, #91)
  - Improved .git detection for Windows
  - Added mandatory .git check for Codex (error if not found)
  - Fixed character encoding issues
- Codex branch name summary processing bug

### Internal

- Test memory leak and hanging issues resolved
  - Added cleanup handlers for PieceEngine and TaskWatcher
  - Changed vitest to single-threaded execution for improved test stability

## [0.5.0] - 2026-02-04

### Changed

- **BREAKING:** Complete terminology migration from "workflow" to "piece" across entire codebase
  - All CLI commands, configuration files, and documentation now use "piece" terminology
  - `WorkflowEngine` → `PieceEngine`
  - `workflow_categories` → `piece_categories` in config files
  - `builtin_workflows_enabled` → `builtin_pieces_enabled`
  - `~/.takt/workflows/` → `~/.takt/pieces/` (user piece directory)
  - `.takt/workflows/` → `.takt/pieces/` (project piece directory)
  - All workflow-related file names and types renamed to piece-equivalents
  - Updated all documentation (README.md, CLAUDE.md, docs/*)

### Internal

- Complete directory structure refactoring:
  - `src/core/workflow/` → `src/core/piece/`
  - `src/features/workflowSelection/` → `src/features/pieceSelection/`
- File renames:
  - `workflow-types.ts` → `piece-types.ts`
  - `workflowExecution.ts` → `pieceExecution.ts`
  - `workflowLoader.ts` → `pieceLoader.ts`
  - `workflowParser.ts` → `pieceParser.ts`
  - `workflowResolver.ts` → `pieceResolver.ts`
  - `workflowCategories.ts` → `pieceCategories.ts`
  - `switchWorkflow.ts` → `switchPiece.ts`
- All test files updated to reflect new terminology (194 files changed, ~3,400 insertions, ~3,400 deletions)
- Resources directory updated:
  - `resources/global/*/pieces/*.yaml` updated with new terminology
  - All prompt files (`*.md`) updated
  - Configuration files (`config.yaml`, `default-categories.yaml`) updated

## [0.4.1] - 2026-02-04

### Fixed

- Workflow execution bug where previous step's response was incorrectly bound to subsequent steps
  - Fixed `MovementExecutor`, `ParallelRunner`, and `state-manager` to properly isolate step responses
  - Updated interactive summary prompts to prevent response leakage

## [0.4.0] - 2026-02-04

### Added

- Externalized prompt system: all internal prompts moved to versioned, translatable files (`src/shared/prompts/en/`, `src/shared/prompts/ja/`)
- i18n label system: UI labels extracted to separate YAML files (`labels_en.yaml`, `labels_ja.yaml`) with `src/shared/i18n/` module
- Prompt preview functionality (`src/features/prompt/preview.ts`)
- Phase system injection into agents for improved workflow phase awareness
- Enhanced debug capabilities with new debug log viewer (`tools/debug-log-viewer.html`)
- Comprehensive test coverage:
  - i18n system tests (`i18n.test.ts`)
  - Prompt system tests (`prompts.test.ts`)
  - Session management tests (`session.test.ts`)
  - Worktree integration tests (`it-worktree-delete.test.ts`, `it-worktree-sessions.test.ts`)

### Changed

- **BREAKING:** Internal terminology renamed: `WorkflowStep` → `WorkflowMovement`, `StepExecutor` → `MovementExecutor`, `ParallelSubStepRawSchema` → `ParallelSubMovementRawSchema`, `WorkflowStepRawSchema` → `WorkflowMovementRawSchema`
- **BREAKING:** Removed unnecessary backward compatibility code
- **BREAKING:** Disabled interactive prompt override feature
- Workflow resource directory renamed: `resources/global/*/workflows/` → `resources/global/*/pieces/`
- Prompts restructured for better readability and maintainability
- Removed unnecessary task requirement summarization from conversation flow
- Suppressed unnecessary report output during workflow execution

### Fixed

- `takt worktree` bug fix for worktree operations

### Internal

- Extracted prompt management into `src/shared/prompts/index.ts` with language-aware file loading
- Created `src/shared/i18n/index.ts` for centralized label management
- Enhanced `tools/jsonl-viewer.html` with additional features
- Major refactoring across 162 files (~5,800 insertions, ~2,900 deletions)

## [0.3.9] - 2026-02-03

### Added

- Workflow categorization support (#85)
  - Default category configuration in `resources/global/{lang}/default-categories.yaml`
  - User-defined categories via `workflow_categories` in `~/.takt/config.yaml`
  - Nested category support with unlimited depth
  - Category-based workflow filtering in workflow selection UI
  - `show_others_category` and `others_category_name` configuration options
  - Builtin workflow filtering via `builtin_workflows_enabled` and `disabled_builtins`
- Agent-less step execution: `agent` field is now optional (#71)
  - Steps can execute with `instruction_template` only (no system prompt)
  - Inline system prompts supported (agent string used as prompt if file doesn't exist)
- `takt add #N` automatically reflects issue number in branch name (#78)
  - Issue number embedded in branch name (e.g., `takt/issue-28-...`)

### Changed

- **BREAKING:** Permission mode values unified to provider-independent format (#87)
  - New values: `readonly`, `edit`, `full` (replaces `default`, `acceptEdits`, `bypassPermissions`)
  - TAKT translates to provider-specific flags (Claude: default/acceptEdits/bypassPermissions, Codex: read-only/workspace-write/danger-full-access)
  - All builtin workflows updated to use new values
- Workflow naming changes:
  - `simple` workflow replaced with `minimal` and `review-fix-minimal`
  - Added `review-only` workflow for read-only code review
- Agent prompts updated with legacy対応禁止ルール (no backward compatibility hacks)
- Documentation updates:
  - README.md and docs/README.ja.md updated with v0.3.8+ features
  - CLAUDE.md significantly expanded with architectural details and implementation notes

### Internal

- Created `src/infra/config/loaders/workflowCategories.ts` for category management
- Created `src/features/workflowSelection/index.ts` for workflow selection UI
- Enhanced `src/shared/prompt/select.ts` with category display support
- Added comprehensive tests for workflow categories (`workflow-categories.test.ts`, `workflow-category-config.test.ts`)

## [0.3.8] - 2026-02-02

### Added

- CLI option to specify workflow/config file paths: `--workflow <path>` and `--config <path>` (#81)
- CI-friendly quiet mode for minimal log output (#70)
- Mock scenario support for testing workflow execution
- Comprehensive integration tests (7 test files, ~3000 lines of test coverage)

### Changed

- Rule evaluation improved: `detectRuleIndex` now uses last match instead of first match (#25)
- `ai_fix` step significantly improved:
  - Added `{step_iteration}` counter to show retry attempt number
  - Explicit fix procedure defined (Read → Grep → Edit → Test → Report)
  - Coder agent now prioritizes reviewer feedback over assumptions
- README and docs updated with clearer CLI usage and CI/CD examples

### Fixed

- Workflow loading priority corrected (user workflows now take precedence over builtins)
- Test stability improvements (flaky tests skipped, ai_fix test updated)
- Slack notification configuration fixed

### Internal

- Refactored instruction builder: extracted context assembly and status rules logic (#44)
- Introduced `src/infra/task/git.ts` for DRY git commit operations
- Unified error handling with `getErrorMessage()`
- Made `projectCwd` required throughout codebase
- Removed deprecated `sacrificeMode`
- 35 files updated for consistency (`console.log` → `blankLine()`, etc.)

## [0.3.7] - 2026-02-01

### Added

- `--pipeline` flag for explicit pipeline/non-interactive mode execution (#28)
- Pipeline mode can be used with both `--task` and `--issue` options

### Changed

- Log file naming changed from base36 to human-readable `YYYYMMDD-HHmmss-random` format (#28)
- `--task` option description updated to clarify it's an alternative to GitHub issue

## [0.3.6] - 2026-01-31

### Fixed

- `ai_review` workflow step now correctly includes `pass_previous_request` setting

## [0.3.5] - 2026-01-31

### Added

- `--create-worktree <yes|no>` option to skip worktree confirmation prompt

### Fixed

- Various CI/CD improvements and fixes (#66, #67, #68, #69)

## [0.3.4] - 2026-01-31

### Added

- Review-only workflow for code review without modifications (#60)
- Various bug fixes and improvements (#14, #23, #35, #38, #45, #50, #51, #52, #59)

## [0.3.3] - 2026-01-31

### Fixed

- Fixed `takt add #N` passing issue content through AI summarization and corrupting task content (#46)
  - Changed to use `resolveIssueTask` result directly as the task when referencing issues

## [0.3.1] - 2026-01-31

### Added

- Interactive task planning mode: `takt` (no args) starts AI conversation to refine task requirements before execution (#47, #5)
  - Session persistence across takt restarts
  - Read-only tools (Read, Glob, Grep, Bash, WebSearch, WebFetch) for codebase investigation
  - Planning-only system prompt prevents code changes during conversation
  - `/go` to confirm and execute, `/cancel` to exit
- Boy Scout Rule enforcement in reviewer/supervisor agent templates

### Changed

- CLI migrated from slash commands (`takt /run-tasks`) to subcommands (`takt run`) (#47)
- `/help` and `/refresh-builtin` commands removed; `eject` simplified
- SDK options builder only includes defined values to prevent hangs

### Fixed

- Claude Agent SDK hanging when `model: undefined` or other undefined options were passed as keys

## [0.3.0] - 2026-01-30

### Added

- Rule-based workflow transitions with 5-stage fallback evaluation (#30)
  - Tag-based conditions: agent outputs `[STEP:N]` tags matched by index
  - `ai()` conditions: AI evaluates free-text conditions against agent output (#9)
  - `all()`/`any()` aggregate conditions for parallel step results (#20)
  - 5-stage evaluation order: aggregate → Phase 3 tag → Phase 1 tag → AI judge → AI fallback
- 3-phase step execution model (#33)
  - Phase 1: Main work (coding, review, etc.)
  - Phase 2: Report output (when `step.report` defined)
  - Phase 3: Status judgment (when tag-based rules exist)
  - Session resumed across phases for context continuity
- Parallel step execution with concurrent sub-steps via `Promise.all()` (#20)
- GitHub Issue integration: execute/add tasks by issue number, e.g. `takt #6` (#10, #34)
- NDJSON session logging with real-time streaming writes (#27, #36)
- Builtin resources embedded in npm package with `/eject` command for customization (#4, #40)
- `edit` property for per-step file edit control
- Rule match method visualization and logging
- Report output auto-generation from YAML `report.format`
- Parallel review support in builtin workflows with spec compliance checking (#31)
- WorkflowEngine mock integration tests (#17, #41)

### Changed

- Report format unified to auto-generation; manual `order`/`instruction_template` for reports removed
- `gitdiff` report type removed in favor of format-based reports

### Fixed

- Report directory correctly includes `.takt/reports/` prefix (#37, #42)
- Unused import in eject.ts (#43)

## [0.2.3] - 2026-01-29

### Added

- `/list-tasks` command for branch management (try merge, merge & cleanup, delete)

### Changed

- Isolated execution migrated from `git worktree` to `git clone --shared` to prevent Claude Code SDK from traversing back to main repository
- Clone lifecycle: auto-deletion after task completion removed; use `/list-tasks` for cleanup
- `worktree.ts` split into `clone.ts` + `branchReview.ts`
- Origin remote removed from clones to block SDK traversal
- All workflow report steps granted Write permission
- `git clone --shared` changed to `--reference --dissociate`

### Fixed

- Version read from `package.json` instead of hardcoded `0.1.0` (#3)

## [0.2.2] - 2026-01-29

### Added

- `/review` instruct action for executing instructions on task branches
- AI-powered task name summarization to English slugs for branch names
- Worktree session inheritance
- Execution Rules metadata (git commit prohibition, cd prohibition)

### Changed

- Status output rule headers auto-generated
- Instructions auto-include worktree change context
- Try Merge changed to squash merge
- `expert-review` renamed to `expert-cqrs`; common reviewers consolidated under `expert/`

### Fixed

- Tasks incorrectly progressing to `completed` on abnormal termination

## [0.2.1] - 2026-01-28

### Added

- Language setting (`ja`/`en`)
- Multiline input support for `/add-task`
- `/review-tasks` command
- Cursor-based (arrow key) menu selection replacing numeric input
- `answer` status, `autoCommit`, `permission_mode`, verbose logging options

### Fixed

- Multiple worktree-related bugs (directory resolution, session handling, creation flow)
- ESC key cancels workflow/task selection

## [0.2.0] - 2026-01-27

### Added

- `/watch` command for file system polling and auto-executing tasks from `.takt/tasks/`
- `/refresh-builtin` command for updating builtin resources
- `/add-task` command for interactive task creation
- Enhanced default workflows

## [0.1.7] - 2026-01-27

### Added

- Schema permission support for workflow validation

## [0.1.6] - 2026-01-27

### Added

- Mock execution mode for testing

### Changed

- `-r` option omitted; default changed to conversation continuation mode

## [0.1.5] - 2026-01-27

### Added

- Total execution time output

### Fixed

- Workflow unintentionally stopping during execution

## [0.1.4] - 2026-01-27

### Changed

- Workflow prompts strengthened
- Transition prompts consolidated into workflow definitions

## [0.1.3] - 2026-01-26

### Fixed

- Iteration stalling issue

## [0.1.2] - 2026-01-26

### Added

- Codex provider support
- Model selection per step/agent
- Permission mode configuration
- Worktree support for isolated task execution
- Project `.gitignore` initialization

### Changed

- Agent prompts refined

## [0.1.1] - 2026-01-25

### Added

- GitHub Actions workflow for npm publish

### Changed

- Interactive mode removed; CLI simplified
