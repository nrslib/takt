# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

alpha.1 の内容を正式リリース。機能変更なし。

## [0.8.0-alpha.1] - 2026-02-07

### Added

- **Faceted Prompting アーキテクチャ**: プロンプト構成要素を独立ファイルとして管理し、ピース間で自由に組み合わせ可能に
  - `personas/` — エージェントの役割・専門性を定義するペルソナプロンプト
  - `policies/` — コーディング規約・品質基準・禁止事項を定義するポリシー
  - `knowledge/` — ドメイン知識・アーキテクチャ情報を定義するナレッジ
  - `instructions/` — ムーブメント固有の手順を定義するインストラクション
  - `output-contracts/` — レポート出力フォーマットを定義するアウトプットコントラクト
  - ピースYAMLのセクションマップ（`personas:`, `policies:`, `knowledge:`）でキーとファイルパスを対応付け、ムーブメントからキーで参照
- **Output Contracts と Quality Gates**: レポート出力の構造化定義と品質基準の AI ディレクティブ
  - `output_contracts` フィールドでレポート定義（`report` フィールドを置き換え）
  - `quality_gates` フィールドでムーブメント完了要件の AI ディレクティブを指定
- **Knowledge システム**: ドメイン知識をペルソナから分離し、ピースレベルで管理・注入
  - ピースYAMLの `knowledge:` セクションマップでナレッジファイルを定義
  - ムーブメントの `knowledge:` フィールドでキー参照して注入
- **Faceted Prompting ドキュメント**: 設計思想と実践ガイドを `docs/faceted-prompting.md`（en/ja）に追加
- **Hybrid Codex ピース生成ツール**: `tools/generate-hybrid-codex.mjs` で Claude ピースから Codex バリアントを自動生成
- 失敗タスクの再投入機能: `takt list` から失敗タスクブランチを選択して再実行可能に (#110)
- ブランチ名生成戦略を設定可能に（`branch_name_strategy` 設定）
- auto-PR 機能の追加と PR 作成ロジックの共通化 (#98)
- Issue 参照時にもピース選択を実施 (#97)
- ステップ（ムーブメント）にいてのスリープ機能

### Changed

- **BREAKING:** `resources/global/` ディレクトリを `builtins/` にリネーム
  - `resources/global/{lang}/` → `builtins/{lang}/`
  - package.json の `files` フィールドを `resources/` → `builtins/` に変更
- **BREAKING:** `agent` フィールドを `persona` にリネーム
  - ピースYAMLの `agent:` → `persona:`、`agent_name:` → `persona_name:`
  - 内部型: `agentPath` → `personaPath`、`agentDisplayName` → `personaDisplayName`、`agentSessions` → `personaSessions`
  - ディレクトリ: `agents/` → `personas/`（グローバル・プロジェクト・ビルトイン全て）
- **BREAKING:** `report` フィールドを `output_contracts` に変更
  - 従来の `report: 00-plan.md` / `report: [{Scope: ...}]` / `report: {name, order, format}` 形式を `output_contracts: {report: [...]}` 形式に統一
- **BREAKING:** `stances` → `policies`、`report_formats` → `output_contracts` にリネーム
- 全ビルトインピースを Faceted Prompting アーキテクチャに移行（旧エージェントプロンプト内のドメイン知識をナレッジに分離）
- SDK 更新: `@anthropic-ai/claude-agent-sdk` v0.2.19 → v0.2.34、`@openai/codex-sdk` v0.91.0 → v0.98.0
- ムーブメントに `policy` / `knowledge` フィールドを追加（セクションマップのキーで参照）
- 対話モードのスコアリングにポリシーベースの評価を追加
- README を刷新: agent → persona、セクションマップの説明追加、制御・管理の分類を明記
- ビルトインスキル（SKILL.md）をFaceted Prompting対応に刷新

### Fixed

- レポートディレクトリパスの解決バグを修正
- PR の Issue 番号リンクが正しく設定されない問題を修正
- `stageAndCommit` で gitignored ファイルがコミットされる問題を修正（`git add -f .takt/reports/` を削除）

### Internal

- ビルトインリソースの大規模再構成: 旧 `agents/` ディレクトリ構造（`default/`, `expert/`, `expert-cqrs/`, `magi/`, `research/`, `templates/`）を廃止し、フラットな `personas/`, `policies/`, `knowledge/`, `instructions/`, `output-contracts/` 構造に移行
- Faceted Prompting のスタイルガイドとテンプレートを追加（`builtins/ja/` に `PERSONA_STYLE_GUIDE.md`, `POLICY_STYLE_GUIDE.md`, `INSTRUCTION_STYLE_GUIDE.md`, `OUTPUT_CONTRACT_STYLE_GUIDE.md` 等）
- `pieceParser.ts` にポリシー・ナレッジ・インストラクションの解決ロジックを追加
- テスト追加: knowledge, policy-persona, deploySkill, StreamDisplay, globalConfig-defaults, sleep, task, taskExecution, taskRetryActions, addTask, saveTaskFile, parallel-logger, summarize 拡充
- `InstructionBuilder` にポリシー・ナレッジコンテンツの注入を追加
- `taskRetryActions.ts` を追加（失敗タスクの再投入ロジック）
- `sleep.ts` ユーティリティを追加
- 旧プロンプトファイル（`interactive-summary.md`, `interactive-system.md`）を削除
- 旧エージェントテンプレート（`templates/coder.md`, `templates/planner.md` 等）を削除

## [0.7.1] - 2026-02-06

### Fixed

- Ctrl+C がピース実行中に効かない問題を修正: SIGINT ハンドラで `interruptAllQueries()` を呼び出してアクティブな SDK クエリを停止するように修正
- Ctrl+C 後に EPIPE クラッシュが発生する問題を修正: SDK が停止済みの子プロセスの stdin に書き込む際の EPIPE エラーを二重防御で抑制（`uncaughtException` ハンドラ + `Promise.resolve().catch()`）
- セレクトメニューの `onKeypress` ハンドラで例外が発生した際にターミナルの raw mode がリークする問題を修正

### Internal

- SIGINT ハンドラと EPIPE 抑制の統合テストを追加（`it-sigint-interrupt.test.ts`）
- セレクトメニューのキー入力安全性テストを追加（`select-rawmode-safety.test.ts`）

## [0.7.0] - 2026-02-06

### Added

- Hybrid Codex ピース: 全主要ピース（default, minimal, expert, expert-cqrs, passthrough, review-fix-minimal, coding）の Codex バリアントを追加
  - coder エージェントを Codex プロバイダーで実行するハイブリッド構成
  - en/ja 両対応
- `passthrough` ピース: タスクをそのまま coder に渡す最小構成ピース
- `takt export-cc` コマンド: ビルトインピース・エージェントを Claude Code Skill としてデプロイ
- `takt list` に delete アクション追加、non-interactive モード分離
- AI 相談アクション: `takt add` / インタラクティブモードで GitHub Issue 作成・タスクファイル保存が可能に
- サイクル検出: ai_review ↔ ai_fix 間の無限ループを検出する `CycleDetector` を追加 (#102)
  - 修正不要時の裁定ステップ（`ai_no_fix`）を default ピースに追加
- CI: skipped な TAKT Action ランを週次で自動削除するワークフローを追加
- ピースカテゴリに Hybrid Codex サブカテゴリを追加（en/ja）

### Changed

- カテゴリ設定を簡素化: `default-categories.yaml` を `piece-categories.yaml` に統合し、ユーザーディレクトリへの自動コピー方式に変更
- ピース選択UIのサブカテゴリナビゲーションを修正（再帰的な階層表示が正しく動作するように）
- Claude Code Skill を Agent Team ベースに刷新
- `console.log` を `info()` に統一（list コマンド）

### Fixed

- Hybrid Codex ピースの description に含まれるコロンが YAML パースエラーを起こす問題を修正
- サブカテゴリ選択時に `selectPieceFromCategoryTree` に不正な引数が渡される問題を修正

### Internal

- `list` コマンドのリファクタリング: `listNonInteractive.ts`, `taskDeleteActions.ts` を分離
- `cycle-detector.ts` を追加、`PieceEngine` にサイクル検出を統合
- ピースカテゴリローダーのリファクタリング（`pieceCategories.ts`, `pieceSelection/index.ts`）
- テスト追加: cycle-detector, engine-loop-monitors, piece-selection, listNonInteractive, taskDeleteActions, createIssue, saveTaskFile

## [0.6.0] - 2026-02-05

RC1/RC2 の内容を正式リリース。機能変更なし。

## [0.6.0-rc1] - 2026-02-05

### Fixed

- ai_review ↔ ai_fix 間の無限ループを修正: ai_fix が「修正不要」と判断した場合に plan へ戻ってフルパイプラインが再起動する問題を解消
  - `ai_no_fix` 調停ステップを追加（architecture-reviewer が ai_review vs ai_fix の対立を判定）
  - ai_fix の「修正不要」ルートを `plan` → `ai_no_fix` に変更
  - 対象ピース: default, expert, expert-cqrs（en/ja）

### Changed

- default ピースの並列レビュアーを security-review → qa-review に変更（TAKT 開発向けに最適化）
- qa-reviewer エージェントを `expert/` から `default/` に移動し、テストカバレッジ重視の内容に書き直し
- ai_review instruction にイテレーション認識を追加（初回は網羅的レビュー、2回目以降は修正確認を優先）

### Internal

- auto-tag ワークフローを release/ ブランチからのマージのみに制限し、publish ジョブを統合（GITHUB_TOKEN 制約による連鎖トリガー不発を解消）
- postversion フック削除（release ブランチフローと競合するため）
- テスト更新: security-reviewer → qa-reviewer の変更に対応

## [0.6.0-rc] - 2026-02-05

### Added

- `coding` ビルトインピース: 設計→実装→並列レビュー→修正の軽量開発ピース（plan/supervise を省略した高速フィードバックループ）
- `conductor` エージェント: Phase 3 判定専用エージェント。レポートやレスポンスを読んで判定タグを出力する
- Phase 3 判定のフォールバック戦略: AutoSelect → ReportBased → ResponseBased → AgentConsult の4段階フォールバックで判定精度を向上 (`src/core/piece/judgment/`)
- セッション状態管理: タスク実行結果（成功/エラー/中断）を保存し、次回インタラクティブモード起動時に前回の結果を表示 (#89)
- TAKT メタ情報（ピース構造、進行状況）をエージェントに引き渡す仕組み
- `/play` コマンド: インタラクティブモードでタスクを即座に実行
- E2Eテスト基盤: mock/provider 両対応のテストインフラ、10種のE2Eテストスペック、テストヘルパー（isolated-env, takt-runner, test-repo）
- レビューエージェントに「論理的に到達不可能な防御コード」の検出ルールを追加

### Changed

- Phase 3 判定ロジックをセッション再開方式から conductor エージェント＋フォールバック戦略に変更（判定の安定性向上）
- CLI ルーティングを `executeDefaultAction()` として関数化し、スラッシュコマンドのフォールバックから再利用可能に (#32)
- `/` や `#` で始まる入力をコマンド/Issue 未検出時にタスク指示として受け入れるよう変更 (#32)
- `isDirectTask()` を簡素化: Issue 参照のみ直接実行、それ以外はすべてインタラクティブモードへ
- 全ビルトインピースから `pass_previous_response: true` を削除（デフォルト動作のため不要）

### Internal

- E2Eテスト設定ファイル追加（vitest.config.e2e.ts, vitest.config.e2e.mock.ts, vitest.config.e2e.provider.ts）
- `rule-utils.ts` に `getReportFiles()`, `hasOnlyOneBranch()`, `getAutoSelectedTag()` を追加
- `StatusJudgmentBuilder` にレポートコンテンツ・レスポンスベースの判定指示生成を追加
- `InstructionBuilder` にピースメタ情報（構造、反復回数）の注入を追加
- テスト追加: judgment-detector, judgment-fallback, sessionState, pieceResolver, cli-slash-hash, e2e-helpers

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
