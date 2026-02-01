# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- Introduced `src/task/git.ts` for DRY git commit operations
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

- `takt add #N` がIssue内容をAI要約に通してしまい、タスク内容が壊れる問題を修正 (#46)
  - Issue参照時は `resolveIssueTask` の結果をそのままタスクとして使用するように変更

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