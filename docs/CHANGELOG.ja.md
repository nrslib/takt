# Changelog

[English](../CHANGELOG.md)

このプロジェクトの注目すべき変更はすべてこのファイルに記録されます。

フォーマットは [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づいています。

## [0.20.0] - 2026-02-19

### Added

- **Faceted Prompting モジュール** (`src/faceted-prompting/`): ファセット合成・解決・テンプレートレンダリング・トランケーションのスタンドアロンライブラリ — TAKT 内部への依存ゼロ。プラガブルなファセットストレージのための `DataEngine` インターフェースと `FileDataEngine`、`CompositeDataEngine` 実装を含む
- **Analytics モジュール** (`src/features/analytics/`): ローカル専用のレビュー品質メトリクス収集 — イベント型（レビュー指摘、修正アクション、ムーブメント結果）、日付ローテーション付き JSONL ライター、レポートパーサー、メトリクス計算
- **`takt metrics review` コマンド**: レビュー品質メトリクスを表示（再報告カウント、ラウンドトリップ率、解決イテレーション数、ルール別 REJECT カウント、反論解決率）。`--since` で時間枠を設定可能
- **`takt purge` コマンド**: 古いアナリティクスイベントファイルを削除。`--retention-days` で保持期間を設定可能
- **`takt reset config` コマンド**: グローバル設定をビルトインテンプレートにリセット（既存設定の自動バックアップ付き）
- **PR 重複防止**: 現在のブランチに既に PR が存在する場合、新規作成ではなく既存 PR へのプッシュとコメント追加で対応 (#304)
- リトライ時のムーブメント選択で失敗箇所にカーソルを初期配置
- run-recovery と config-priority シナリオの E2E テストを追加

### Changed

- **README を大幅改訂**: 約950行から約270行に圧縮 — 詳細情報を専用ドキュメント（`docs/configuration.md`、`docs/cli-reference.md`、`docs/task-management.md`、`docs/ci-cd.md`、`docs/builtin-catalog.md`）に分離し、日本語版も作成。プロダクトコンセプトを4軸（すぐ始められる、実用的、再現可能、マルチエージェント）で再定義
- **設定システムのリファクタリング**: 設定解決を `resolveConfigValue()` と `loadConfig()` に統一し、コードベース全体に散在していた設定アクセスパターンを解消
- **`takt config` コマンド削除**: デフォルトへのリセットを行う `takt reset config` に置き換え
- ビルトイン設定テンプレートのコメントと構造を刷新
- `@anthropic-ai/claude-agent-sdk` を v0.2.47 に更新
- タスク再指示のインストラクトモードプロンプトを改善

### Fixed

- ビルトインピースのファイル参照が相対パスではなく絶対パスを使用していた問題を修正 (#304)
- 複数ファイルにまたがる未使用 import・変数を削除

### Internal

- `loadConfig`、`resolveConfigValue`、ピース設定解決、設定優先順位パスの統一
- config-priority と run-recovery シナリオの E2E テストを追加
- PR 作成フローテスト用の `postExecution.test.ts` を追加
- 未使用 import・変数のクリーンアップ

## [0.19.0] - 2026-02-18

### Added

- 失敗タスク専用のリトライモードを追加 — 失敗コンテキスト（エラー詳細、失敗ムーブメント、最終メッセージ）、実行セッションデータ、ピース構成をシステムプロンプトに注入する対話ループ
- 完了/失敗タスクの再指示用に専用 instruct システムプロンプトを追加 — タスク名・内容・ブランチ変更・リトライノートを汎用の対話プロンプトではなく直接プロンプトに注入
- `takt list` からの直接再実行 — "execute" アクションで既存ワークツリー内で即座にタスクを実行（pending への再キューだけでなく）
- `startReExecution` によるアトミックなタスクステータス遷移 — completed/failed から直接 running に遷移し、requeue → claim のレースコンディションを回避
- タスク実行時のワークツリー再利用 — 既存のクローンディレクトリがディスク上に残っていればそのまま再利用（ブランチ名生成やクローン作成をスキップ）
- 対話モードおよびサマリーシステムプロンプトにタスク履歴を注入 — completed/failed/interrupted タスクのサマリーをコンテキストとして提供
- 対話モードおよび instruct システムプロンプトに前回実行の参照機能 — ログとレポートを参照可能に
- `findRunForTask` / `getRunPaths` ヘルパー — タスク内容による実行セッションの自動検索
- `isStaleRunningTask` プロセスヘルパーを TaskLifecycleService から抽出し再利用可能に

### Changed

- interactive モジュール分割: `interactive.ts` を `interactive-summary.ts`、`runSelector.ts`、`runSessionReader.ts`、`selectorUtils.ts` にリファクタリング
- `requeueTask` が汎用の `allowedStatuses` パラメータを受け取るように変更（`failed` のみだった制約を解除）
- `takt list` の instruct/retry アクションがプロジェクトルートではなくワークツリーパスを使用して対話と実行データの参照を行うように変更
- `save_task` アクションはタスクを再キュー（後で実行用に保存）、`execute` アクションは即座に実行

### Internal

- `DebugConfig` をモデル・スキーマ・グローバル設定から削除 — verbose モードのみに簡素化
- stdin シミュレーションテストヘルパー（`stdinSimulator.ts`）を追加し、E2E 対話ループテストを実現
- リトライモード、対話ルーティング、実行セッション注入の包括的な E2E テストを追加
- `check:release` npm スクリプトを追加（リリース前検証用）

## [0.18.2] - 2026-02-18

### Added

- グローバル設定に `codex_cli_path` オプションと `TAKT_CODEX_CLI_PATH` 環境変数を追加 — Codex SDK が使用する CLI バイナリのパスを上書き可能に (#292)
  - 厳密なバリデーション付き: 絶対パス、ファイル存在確認、実行権限、制御文字の禁止
  - 優先順位: `TAKT_CODEX_CLI_PATH` 環境変数 > config.yaml の `codex_cli_path` > SDK 同梱バイナリ

## [0.18.1] - 2026-02-18

### Added

- セキュリティナレッジにマルチテナントデータ分離セクションと認可・リゾルバー整合性のコード例を追加
- コーディングポリシーに「プロジェクトスクリプト優先」ルールを追加 — npm スクリプトが存在するのに直接ツール呼び出し（例: `npx vitest`）を検出

## [0.18.0] - 2026-02-17

### Added

- `deep-research` ピースを追加 — 計画→深掘り→分析→統括の4ステップで多角的なリサーチを行うワークフロー
- プロジェクトレベルの `.takt/` ファセット（pieces, personas, policies, knowledge, instructions, output-contracts）をバージョン管理可能に (#286)
- リサーチ系ファセットを新規追加（research ポリシー、ナレッジ、比較分析ナレッジ、専用ペルソナ・インストラクション）

### Changed

- `research` ピースをリファクタリング — ペルソナに埋め込まれていたルール・知識をポリシー・ナレッジ・インストラクションに分離し、ファセット設計に準拠
- 既存ピース（expert, expert-cqrs, backend, backend-cqrs, frontend）に knowledge/policy 参照を追加

### Fixed

- `.takt/.gitignore` テンプレート（dotgitignore）のパスが `.takt/` プレフィックス付きで記述されていたため、ファセットディレクトリが追跡されないバグを修正

### Internal

- ナレッジファセットのスタイルガイド（KNOWLEDGE_STYLE_GUIDE.md）を作成
- dotgitignore パターンの回帰テストを追加

## [0.17.3] - 2026-02-16

### Added

- ビルトインの AI アンチパターンポリシーとフロントエンドナレッジに API クライアント生成の一貫性ルールを追加 — 生成ツール（Orval 等）が存在するプロジェクトでの手書きクライアント混在を検出

### Fixed

- タスクストアのロック解放時に EPERM クラッシュが発生する問題を修正 — ファイルベースロックからインメモリガードに置き換え

### Internal

- e2e テストの vitest 設定を共通化し、forceExit オプション追加でゾンビワーカーを防止

## [0.17.2] - 2026-02-15

### Added

- `expert-mini`、`expert-cqrs-mini` ピースを追加 — Expert ピースの軽量版として、plan → implement → 並列レビュー（AI アンチパターン＋スーパーバイザー）→ 修正のワークフローを提供
- ピースカテゴリの「⚡ Mini」「🔧 エキスパート」に新ピースを追加

### Fixed

- パーミッションモード未解決時にエラーをスローしていた問題を修正 — `readonly` にフォールバックするように変更

## [0.17.1] - 2026-02-15

### Changed

- `.takt/.gitignore` テンプレートをホワイトリスト方式に変更 — デフォルトで全ファイルを無視し、`config.yaml` のみを追跡対象に。新しいファイルが追加されても ignore 漏れが発生しない

## [0.17.0] - 2026-02-15

### Added

- **mini ピースシリーズ**: `default-mini`、`frontend-mini`、`backend-mini`、`backend-cqrs-mini` を追加 — `coding`/`minimal` の後継として、並列レビュー（AI アンチパターン＋スーパーバイザー）付きの軽量開発ピースを提供
- ピースカテゴリに「⚡ Mini」カテゴリを追加
- `supervisor-validation` 出力契約を追加 — 要件充足チェックテーブル（Requirements Fulfillment Check）で要件ごとにコード根拠を提示する形式
- `getJudgmentReportFiles()`: `use_judge` フラグにより Phase 3 ステータス判定の対象レポートをフィルタリング可能に
- Output contract に finding_id トラッキングを追加（new/persists/resolved セクションによる指摘の追跡）

### Changed

- **BREAKING: `coding` ピースと `minimal` ピースを削除** — mini ピースシリーズに置き換え。`coding` → `default-mini`、`minimal` → `default-mini` への移行を推奨
- **BREAKING: Output contract を item 形式に統一** — `use_judge`（boolean）と `format`（string）フィールドを必須化し、`OutputContractLabelPath`（label:path 形式）を廃止
- ランタイム環境ディレクトリを `.runtime` から `.takt/.runtime` に移動
- スーパーバイザーの要件充足検証を強化: 要件を個別に抽出し、コード（file:line）に対して1件ずつ検証する方式に変更 — 「おおむね完了」は APPROVE の根拠にならない

### Fixed

- クローン/worktree ディレクトリの削除にリトライ機構を追加（`maxRetries: 3`, `retryDelay: 200`）— ファイルロックによる一時的な削除失敗を軽減

### Internal

- `review-summary` 出力契約を削除（`supervisor-validation` に統合）
- 全ビルトインピース、e2e フィクスチャ、テストを output contract の新形式に更新

## [0.16.0] - 2026-02-15

### Added

- **プロバイダー別パーミッションプロファイル（`provider_profiles`）**: グローバル設定（`~/.takt/config.yaml`）およびプロジェクト設定（`.takt/config.yaml`）でプロバイダーごとのデフォルトパーミッションモードとムーブメント単位のオーバーライドを定義可能に — 5段階の優先順位解決（project override → global override → project default → global default → `required_permission_mode` 下限補正）

### Changed

- **BREAKING: `permission_mode` → `required_permission_mode`**: ムーブメントの `permission_mode` フィールドを `required_permission_mode` にリネーム — 下限（フロア）として機能し、実際のパーミッションモードは `provider_profiles` で解決される設計に変更。旧 `permission_mode` は `z.never()` で拒否されるため後方互換性なし
- ビルトイン `config.yaml` テンプレートを全面リライト: コメント整理、`provider_profiles` の説明と使用例を追加、OpenCode 関連設定の追加

### Internal

- プロバイダープロファイル関連のテスト追加（global-provider-profiles, project-provider-profiles, permission-profile-resolution, options-builder）
- 並行実行テストに不足していた `loadProjectConfig` モックを追加

## [0.15.0] - 2026-02-15

### Added

- **ランタイム環境プリセット**: `piece_config.runtime.prepare` およびグローバル設定の `runtime.prepare` で、ピース実行前に環境準備スクリプトを自動実行可能に — ビルトインプリセット（`gradle`, `node`）で依存解決・キャッシュ設定を `.runtime/` ディレクトリに隔離
- **ループモニターの judge インストラクション**: `loop_monitors` の judge 設定で `instruction_template` フィールドをサポート — ループ判定の指示をインストラクションファセットとして外部化し、ビルトインピース（expert, expert-cqrs）に適用

### Internal

- ランタイム環境関連のテスト追加（runtime-environment, globalConfig-defaults, models, provider-options-piece-parser）
- provider e2e テスト追加（runtime-config-provider）

## [0.14.0] - 2026-02-14

### Added

- **`takt list` インストラクトモード (#267)**: 既存ブランチに対して追加指示を行えるインストラクトモードを追加 — 会話ループで要件を詳細化してからピース実行が可能に
- **`takt list` 完了タスクアクション (#271)**: 完了タスクに対する diff 表示・ブランチ操作（マージ、削除）を追加
- **Claude サンドボックス設定**: `provider_options.claude.sandbox` でサンドボックスの除外コマンド（`excluded_commands`）やサンドボックス無効化（`allow_unsandboxed_commands`）を設定可能に
- **`provider_options` のグローバル/プロジェクト設定**: `provider_options` を `~/.takt/config.yaml`（グローバル）および `.takt/config.yaml`（プロジェクト）で設定可能に — ピースレベル設定の最低優先フォールバックとして機能

### Changed

- **provider/model の解決ロジックを AgentRunner に集約**: provider 解決でプロジェクト設定をカスタムエージェント設定より優先するよう修正。ステップレベルの `stepModel` / `stepProvider` による上書きを追加
- **ポストエクスキューションの共通化**: インタラクティブモードとインストラクトモードで post-execution フロー（auto-commit, push, PR 作成）を `postExecution.ts` に共通化
- **スコープ縮小防止策をインストラクションに追加**: plan, ai-review, supervise のインストラクションに要件の取りこぼし検出を追加 — plan では要件ごとの「変更要/不要」判定と根拠提示を必須化、supervise では計画レポートの鵜呑み禁止

### Fixed

- インタラクティブモードの選択肢が非同期実行時に表示されてしまうバグを修正 (#266)
- OpenCode のパラレル実行時にセッション ID を引き継げない問題を修正 — サーバーをシングルトン化し並列実行時の競合を解消
- OpenCode SDK サーバー起動タイムアウトを 30 秒から 60 秒に延長

### Internal

- タスク管理の大規模リファクタリング: `TaskRunner` の責務を `TaskLifecycleService`、`TaskDeletionService`、`TaskQueryService` に分離
- `taskActions.ts` を機能別に分割: `taskBranchLifecycleActions.ts`、`taskDiffActions.ts`、`taskInstructionActions.ts`、`taskDeleteActions.ts`
- `postExecution.ts`、`taskResultHandler.ts`、`instructMode.ts`、`taskActionTarget.ts` を新規追加
- ピース選択ロジックを `pieceSelection/index.ts` に集約（`selectAndExecute.ts` から抽出）
- テスト追加: instructMode, listNonInteractive-completedActions, listTasksInteractiveStatusActions, option-resolution-order, taskInstructionActions, selectAndExecute-autoPr 等を新規・拡充
- E2E テストに Claude Code サンドボックス対応オプション（`dangerouslyDisableSandbox`）を追加
- `OPENCODE_CONFIG_CONTENT` を `.gitignore` に追加

## [0.13.0] - 2026-02-13

### Added

- **Team Leader ムーブメント**: ムーブメント内でチームリーダーエージェントがタスクを動的にサブタスク（Part）へ分解し、複数のパートエージェントを並列実行する新しいムーブメントタイプ — `team_leader` 設定（persona, maxParts, timeoutMs, partPersona, partEdit, partPermissionMode）をサポート (#244)
- **構造化出力（Structured Output）**: エージェント呼び出しに JSON Schema ベースの構造化出力を導入 — タスク分解（decomposition）、ルール評価（evaluation）、ステータス判定（judgment）の3つのスキーマを `builtins/schemas/` に追加。Claude / Codex 両プロバイダーで対応 (#257)
- **`provider_options` ピースレベル設定**: ピース全体（`piece_config.provider_options`）および個別ムーブメントにプロバイダー固有オプション（`codex.network_access`、`opencode.network_access`）を設定可能に — 全ビルトインピースに Codex/OpenCode のネットワークアクセスを有効化
- **`backend` ビルトインピース**: バックエンド開発特化のピースを新規追加 — バックエンド、セキュリティ、QA の並列専門家レビュー対応
- **`backend-cqrs` ビルトインピース**: CQRS+ES 特化のバックエンド開発ピースを新規追加 — CQRS+ES、セキュリティ、QA の並列専門家レビュー対応
- **AbortSignal によるパートタイムアウト**: Team Leader のパート実行にタイムアウト制御と親シグナル連動の AbortSignal を追加
- **エージェントユースケース層**: `agent-usecases.ts` にエージェント呼び出しのユースケース（`decomposeTask`, `executeAgent`, `evaluateRules`）を集約し、構造化出力の注入を一元管理

### Changed

- **BREAKING: パブリック API の整理**: `src/index.ts` の公開 API を大幅に絞り込み — 内部実装の詳細（セッション管理、Claude/Codex クライアント詳細、ユーティリティ関数等）を非公開化し、安定した最小限の API サーフェスに (#257)
- **Phase 3 判定ロジックの刷新**: `JudgmentDetector` / `FallbackStrategy` を廃止し、構造化出力ベースの `status-judgment-phase.ts` に統合。判定の安定性と保守性を向上 (#257)
- **Report フェーズのリトライ改善**: Report Phase（Phase 2）が失敗した場合、新規セッションで自動リトライするよう改善 (#245)
- **Ctrl+C シャットダウンの統一**: `sigintHandler.ts` を廃止し、`ShutdownManager` に統合 — グレースフルシャットダウン → タイムアウト → 強制終了の3段階制御を全プロバイダーで共通化 (#237)
- **スコープ外削除の防止ガードレール**: coder ペルソナにタスク指示書の範囲外の削除・構造変更を禁止するルールを追加。planner ペルソナにスコープ規律と参照資料の優先順位を追加
- フロントエンドナレッジにデザイントークンとテーマスコープのガイダンスを追加
- アーキテクチャナレッジの改善（en/ja 両対応）

### Fixed

- clone 時に既存ブランチの checkout が失敗する問題を修正 — `git clone --shared` で `--branch` を渡してからリモートを削除するよう変更
- Issue 参照付きブランチ名から `#` を除去（`takt/#N/slug` → `takt/N/slug`）
- OpenCode の report フェーズで deprecated ツール依存を解消し、permission 中心の制御へ移行 (#246)
- 不要な export を排除し、パブリック API の整合性を確保

### Internal

- Team Leader 関連のテスト追加（engine-team-leader, team-leader-schema-loader, task-decomposer）
- 構造化出力関連のテスト追加（parseStructuredOutput, claude-executor-structured-output, codex-structured-output, provider-structured-output, structured-output E2E）
- ShutdownManager のユニットテスト追加
- AbortSignal のユニットテスト追加（abort-signal, claude-executor-abort-signal, claude-provider-abort-signal）
- Report Phase リトライのユニットテスト追加（report-phase-retry）
- パブリック API エクスポートのユニットテスト追加（public-api-exports）
- provider_options 関連のテスト追加（provider-options-piece-parser, models, opencode-types）
- E2E テストの大幅拡充: cycle-detection, model-override, multi-step-sequential, pipeline-local-repo, report-file-output, run-sigint-graceful, session-log, structured-output, task-status-persistence
- E2E テストヘルパーのリファクタリング（共通 setup 関数の抽出）
- `judgment/` ディレクトリ（JudgmentDetector, FallbackStrategy）を削除
- `ruleIndex.ts` ユーティリティを追加（1-based → 0-based インデックス変換）

## [0.12.1] - 2026-02-11

### Fixed

- セッションが見つからない場合に無言で新規セッションに進む問題を修正 — セッション未検出時に info メッセージを表示するように改善

### Internal

- OpenCode プロバイダーの report フェーズを deny に設定（Phase 2 での不要な書き込みを防止）
- プロジェクト初期化時の `tasks/` ディレクトリコピーをスキップ（TASK-FORMAT が不要になったため）
- ストリーム診断ユーティリティ (`streamDiagnostics.ts`) を追加

## [0.12.0] - 2026-02-11

### Added

- **OpenCode プロバイダー**: 第3のプロバイダーとして OpenCode をネイティブサポート — `@opencode-ai/sdk/v2` による SDK 統合、権限マッピング（readonly/edit/full → reject/once/always）、SSE ストリーム処理、リトライ機構（最大3回）、10分タイムアウトによるハング検出 (#236, #238)
- **Arpeggio ムーブメント**: データ駆動バッチ処理の新ムーブメントタイプ — CSV データソースからバッチ分割、テンプレート展開（`{line:N}`, `{col:N:name}`, `{batch_index}`）、並行 LLM 呼び出し（Semaphore 制御）、concat/custom マージ戦略をサポート (#200)
- **`frontend` ビルトインピース**: フロントエンド開発特化のピースを新規追加 — React/Next.js 向けの knowledge 注入、coding/testing ポリシー適用、並列アーキテクチャレビュー対応
- **Slack Webhook 通知**: ピース実行完了時に Slack へ自動通知 — `TAKT_NOTIFY_WEBHOOK` 環境変数で設定、10秒タイムアウト、失敗時も他処理をブロックしない (#234)
- **セッション選択 UI**: インタラクティブモード開始時に Claude Code の過去セッションから再開可能なセッションを選択可能に — 最新10セッションの一覧表示、初期入力・最終応答プレビュー付き (#180)
- **プロバイダーイベントログ**: Claude/Codex/OpenCode の実行中イベントを NDJSON 形式でファイル出力 — `.takt/logs/{sessionId}-provider-events.jsonl` に記録、長大テキストの自動圧縮 (#236)
- **プロバイダー・モデル名の出力表示**: 各ムーブメント実行時に使用中のプロバイダーとモデル名をコンソールに表示

### Changed

- **`takt add` の刷新**: Issue 選択時にタスクへの自動追加、インタラクティブモードの廃止、Issue 作成時のタスク積み込み確認 (#193, #194)
- **`max_iteration` → `max_movement` 統一**: イテレーション上限の用語を統一し、無限実行指定として `ostinato` を追加 (#212)
- **`previous_response` 注入仕様の改善**: 長さ制御と Source Path 常時注入を実装 (#207)
- **タスク管理の改善**: `.takt/tasks/` を長文タスク仕様の置き場所として再定義、`completeTask()` で completed レコードを `tasks.yaml` から削除 (#201, #204)
- **レビュー出力の改善**: レビュー出力を最新化し、過去レポートは履歴ログへ分離 (#209)
- **ビルトインピース簡素化**: 全ビルトインピースのトップレベル宣言をさらに整理

### Fixed

- **Report Phase blocked 時の動作修正**: Report Phase（Phase 2）で blocked 状態の際に新規セッションでリトライするよう修正 (#163)
- **OpenCode のハング・終了判定の修正**: プロンプトのエコー抑制、question の抑制、ハング問題の修正、終了判定の誤りを修正 (#238)
- **OpenCode の権限・ツール設定の修正**: edit 実行時の権限とツール配線を修正
- **Worktree へのタスク指示書コピー**: Worktree 実行時にタスク指示書が正しくコピーされるよう修正
- lint エラーの修正（merge/resolveTask/confirm）

### Internal

- OpenCode プロバイダーの包括的なテスト追加（client-cleanup, config, provider, stream-handler, types）
- Arpeggio の包括的なテスト追加（csv, data-source-factory, merge, schema, template, engine-arpeggio）
- E2E テストの大幅な拡充: cli-catalog, cli-clear, cli-config, cli-export-cc, cli-help, cli-prompt, cli-reset-categories, cli-switch, error-handling, piece-error-handling, provider-error, quiet-mode, run-multiple-tasks, task-content-file (#192, #198)
- `providerEventLogger.ts`, `providerModel.ts`, `slackWebhook.ts`, `session-reader.ts`, `sessionSelector.ts`, `provider-resolution.ts`, `run-paths.ts` の新規追加
- `ArpeggioRunner.ts` の新規追加（データ駆動バッチ処理エンジン）
- AI Judge をプロバイダーシステム経由に変更（Codex/OpenCode 対応）
- テスト追加・拡充: report-phase-blocked, phase-runner-report-history, judgment-fallback, pieceExecution-session-loading, globalConfig-defaults, session-reader, sessionSelector, slackWebhook, providerEventLogger, provider-model, interactive, run-paths, engine-test-helpers

## [0.11.1] - 2026-02-10

### Fixed

- AI Judge がプロバイダーシステムを経由するよう修正 — `callAiJudge` を Claude 固定実装からプロバイダー経由（`runAgent`）に変更し、Codex プロバイダーでも AI 判定が正しく動作するように
- 実行指示が長大化する問題を緩和 — implement/fix 系ムーブメントで `pass_previous_response: false` を設定し、Report Directory 内のレポートを一次情報として優先する指示に変更（en/ja 両対応）

### Internal

- stable release 時に npm の `next` dist-tag を `latest` と自動同期するよう CI ワークフローを改善（リトライ付き）

## [0.11.0] - 2026-02-10

### Added

- **`e2e-test` ビルトインピース**: E2Eテスト特化のピースを新規追加 — E2E分析 → E2E実装 → レビュー → 修正のフロー（VitestベースのE2Eテスト向け）
- **`error` ステータス**: プロバイダーエラーを `blocked` から分離し、エラー状態を明確に区別可能に。Codex にリトライ機構を追加
- **タスク YAML 一元管理**: タスクファイルの管理を `tasks.yaml` に統合。`TaskRecordSchema` による構造化されたタスクライフサイクル管理（pending/running/completed/failed）
- **タスク指示書ドキュメント**: タスク指示書の構造と目的を明文化 (#174)
- **レビューポリシー**: 共通レビューポリシーファセット（`builtins/{lang}/policies/review.md`）を追加
- **SIGINT グレースフルシャットダウンの E2E テスト**: 並列実行中の Ctrl+C 動作を検証する E2E テストを追加

### Changed

- **ビルトインピース簡素化**: 全ビルトインピースからトップレベルの `policies`/`personas`/`knowledge`/`instructions`/`report_formats` 宣言を削除し、名前ベースの暗黙的解決に移行。ピース YAML がよりシンプルに
- **ピースカテゴリ仕様更新**: カテゴリの設定・表示ロジックを改善。グローバル設定でのカテゴリ管理を強化 (#184)
- **`takt list` の優先度・参照改善**: ブランチ解決のパフォーマンス最適化。ベースコミットキャッシュの導入 (#186, #195, #196)
- **Ctrl+C シグナルハンドリング改善**: 並列実行中の SIGINT 処理を安定化
- **ループ防止ポリシー強化**: エージェントの無限ループを防止するためのポリシーを強化

### Fixed

- オリジナル指示の差分処理が正しく動作しない問題を修正 (#181)
- タスク指示書のゴールが不適切にスコープ拡張される問題を修正 — ゴールを常に実装・実行に固定

### Internal

- タスク管理コードの大規模リファクタリング: `parser.ts` を廃止し `store.ts`/`mapper.ts`/`schema.ts`/`naming.ts` に分離。`branchGitResolver.ts`/`branchBaseCandidateResolver.ts`/`branchBaseRefCache.ts`/`branchEntryPointResolver.ts` でブランチ解決を細分化
- テストの大幅な拡充・リファクタリング: aggregate-evaluator, blocked-handler, branchGitResolver-performance, branchList-regression, buildListItems-performance, error-utils, escape, facet-resolution, getFilesChanged, global-pieceCategories, instruction-context, instruction-helpers, judgment-strategies, listTasksInteractivePendingLabel, loop-detector, naming, reportDir, resetCategories, rule-evaluator, rule-utils, slug, state-manager, switchPiece, task-schema, text, transitions, watchTasks 等を新規追加
- Codex クライアントのリファクタリング
- ピースパーサーのファセット解決ロジック改善

## [0.10.0] - 2026-02-09

### Added

- **`structural-reform` ビルトインピース**: プロジェクト全体のレビューと構造改革 — `loop_monitors` を活用した反復的なコードベース再構成（段階的なファイル分割）ワークフロー
- **`unit-test` ビルトインピース**: ユニットテスト特化のピース — テスト分析 → テスト実装 → レビュー → 修正のフロー。`loop_monitors` によるサイクル制御付き
- **`test-planner` ペルソナ**: コードベースを解析し、包括的なテスト戦略を立案する専用ペルソナ
- **インタラクティブモードのバリアント**: ピース選択後に4種のモードから選択可能 — `assistant`（デフォルト: AI 支援による要件整理）、`persona`（最初のムーブメントのペルソナとの会話）、`quiet`（質問なしで指示書を生成）、`passthrough`（ユーザー入力をそのまま使用）
- **`persona_providers` 設定**: ペルソナごとのプロバイダーオーバーライド（例: `{ coder: 'codex' }`）— ハイブリッドピースを作成せずに特定ペルソナを別プロバイダーへルーティング可能
- **`task_poll_interval_ms` 設定**: `takt run` が実行中に新規タスクを検出するポーリング間隔を設定可能（デフォルト: 500ms、範囲: 100〜5000ms）
- **`interactive_mode` ピースフィールド**: ピースレベルのデフォルトインタラクティブモードを上書き可能（例: AI 計画が不要なピースに `passthrough` を設定）
- **タスクレベル出力プレフィックス**: `takt run` の並列実行時、全出力行に色付きの `[taskName]` プレフィックスを付与し、並行タスク間の行途中混在を防止
- **レビューポリシーファセット**: ピース間でレビュー基準を統一する共通レビューポリシー（`builtins/{lang}/policies/review.md`）

### Changed

- **BREAKING:** ハイブリッド Codex ピース（`*-hybrid-codex`）を全廃 — `persona_providers` 設定で同等の機能を実現できるため、ピースファイルの重複が不要に
- `tools/generate-hybrid-codex.mjs` を削除（`persona_providers` により不要）
- 並列実行時の出力改善: ムーブメントレベルプレフィックスに並行実行時のタスクコンテキストとイテレーション情報を追加
- Codex クライアントがストリームのハングを検出するように（10分間アイドルタイムアウト）。タイムアウト vs 外部中断をエラーメッセージで区別
- 並列タスク実行（`takt run`）がタスク完了間のみではなく実行中にも新規追加タスクをポーリングするよう変更
- 並列タスク実行でタスクごとの時間制限を廃止（従来はタイムアウトあり）
- Issue 参照がインタラクティブモードをスキップせず、最初の入力としてインタラクティブモードを経由するよう変更
- ビルトイン `config.yaml` を更新し、GlobalConfig の全フィールドをドキュメント化
- インタラクティブモードのバリアント間で会話ロジックを共有する `conversationLoop.ts` を抽出
- ラインエディタの改善: キーバインドの追加とエッジケースの修正

### Fixed

- ストリームがアイドル状態になった際に Codex プロセスが無期限にハングする問題を修正 — 10分間アクティビティがない場合に中断し、ワーカープールのスロットを解放

### Internal

- 新規テスト追加: engine-persona-providers, interactive-mode（532行）, task-prefix-writer, workerPool 拡充, pieceResolver 拡充, lineEditor 拡充, parallel-logger 拡充, globalConfig-defaults 拡充, pieceExecution-debug-prompts 拡充, it-piece-loader 拡充, runAllTasks-concurrency 拡充, engine-parallel
- 並列出力管理のための `TaskPrefixWriter` を抽出
- `modeSelection.ts`, `passthroughMode.ts`, `personaMode.ts`, `quietMode.ts` をインタラクティブモジュールから抽出
- `InteractiveMode` 型モデルを追加（`src/core/models/interactive-mode.ts`）
- `PieceEngine` が構築時に `taskPrefix`/`taskColorIndex` ペアの整合性を検証するよう変更
- 実装メモを追加（`docs/implements/retry-and-session.ja.md`）

## [0.9.0] - 2026-02-08

### Added

- **`takt catalog` コマンド**: 各レイヤー（builtin/user/project）にわたって利用可能なファセット（personas, policies, knowledge, instructions, output-contracts）を一覧表示
- **`compound-eye` ビルトインピース**: マルチモデルレビュー — 同一の指示を Claude と Codex に同時送信し、両者の回答を統合
- **並列タスク実行**: `takt run` がワーカープールによる並行タスク実行をサポート（`concurrency` 設定で制御、デフォルト: 1）
- **インタラクティブモードのリッチなラインエディタ**: Shift+Enter で複数行入力、カーソル移動（矢印キー、Home/End）、Option+Arrow で単語単位移動、Ctrl+A/E/K/U/W 編集、ブラケットペーストモード対応
- **インタラクティブモードでのムーブメントプレビュー**: ピースのムーブメント構造（ペルソナ＋インストラクション）を AI プランナーに注入してタスク分析を改善（`interactive_preview_movements` 設定、デフォルト: 3）
- **MCP サーバー設定**: ムーブメントごとの MCP（Model Context Protocol）サーバー設定。stdio/SSE/HTTP トランスポートをサポート
- **ファセット単位の eject**: `takt eject persona coder` — ファセットをタイプと名前で個別にエジェクトしてカスタマイズ可能に
- **3層ファセット解決**: ペルソナ、ポリシー、その他のファセットを project → user → builtin の順で解決（名前ベースの参照をサポート）
- **`pr-commenter` ペルソナ**: レビュー所見を GitHub PR コメントとして投稿する専用ペルソナ
- **`notification_sound` 設定**: 通知音の有効/無効を設定可能（デフォルト: true）
- **プロンプトログビューア**: デバッグ時のプロンプトと回答のペアを可視化する `tools/prompt-log-viewer.html`
- auto-PR のベースブランチをブランチ作成前の現在のブランチに設定するよう変更

### Changed

- プランナーとアーキテクト・プランナーを統合: 設計知識をナレッジファセットに抽出・統合。default/coding ピースからアーキテクトムーブメントを削除（plan → implement への直接遷移に変更）
- インタラクティブモードを readline からローモードのラインエディタに置き換え（カーソル管理、行間移動、Kitty キーボードプロトコル）
- インタラクティブモードの `save_task` を `takt add` の worktree セットアップフローに統合
- caffeinate に `-d` フラグを追加してディスプレイスリープ中の App Nap によるプロセスフリーズを防止
- Issue 参照がインタラクティブモードをスキップせず、最初の入力としてインタラクティブモードを経由するよう変更（従来は直接実行）
- SDK 更新: `@anthropic-ai/claude-agent-sdk` v0.2.34 → v0.2.37
- インタラクティブセッションのスコアリングプロンプトにピース構造情報を追加

### Internal

- ファセット解決ロジックのための `resource-resolver.ts` を抽出（`pieceParser.ts` から分離）
- `parallelExecution.ts`（ワーカープール）、`resolveTask.ts`（タスク解決）、`sigintHandler.ts`（共通 SIGINT ハンドラ）を抽出
- `session-key.ts` によるセッションキー生成の統一
- 新規 `lineEditor.ts`（ローモードターミナル入力、エスケープシーケンス解析、カーソル管理）
- 大幅なテスト追加: catalog, facet-resolution, eject-facet, lineEditor, formatMovementPreviews, models, debug, strip-ansi, workerPool, runAllTasks-concurrency, session-key, interactive（大規模拡充）, cli-routing-issue-resolve, parallel-logger, engine-parallel-failure, StreamDisplay, getCurrentBranch, globalConfig-defaults, pieceExecution-debug-prompts, selectAndExecute-autoPr, it-notification-sound, it-piece-loader, permission-mode（拡充）

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

- Windows 環境でのファイルパス処理と文字エンコーディングの問題を修正 (#90, #91)
  - Windows 向けの `.git` 検出を改善
  - Codex 向けに `.git` の必須チェックを追加（未検出時はエラー）
  - 文字エンコーディングの問題を修正
- Codex のブランチ名サマリー処理のバグを修正

### Internal

- テストのメモリリークとハング問題を解消
  - `PieceEngine` と `TaskWatcher` にクリーンアップハンドラを追加
  - テストの安定性向上のため vitest をシングルスレッド実行に変更

## [0.5.0] - 2026-02-04

### Changed

- **BREAKING:** コードベース全体で "workflow" から "piece" への用語移行を完了
  - 全 CLI コマンド、設定ファイル、ドキュメントで "piece" 用語を使用
  - `WorkflowEngine` → `PieceEngine`
  - `workflow_categories` → `piece_categories`（設定ファイル）
  - `builtin_workflows_enabled` → `builtin_pieces_enabled`
  - `~/.takt/workflows/` → `~/.takt/pieces/`（ユーザーピースディレクトリ）
  - `.takt/workflows/` → `.takt/pieces/`（プロジェクトピースディレクトリ）
  - ワークフロー関連のファイル名・型をすべてピース相当に改名
  - 全ドキュメントを更新（README.md, CLAUDE.md, docs/*）

### Internal

- ディレクトリ構造を全面リファクタリング:
  - `src/core/workflow/` → `src/core/piece/`
  - `src/features/workflowSelection/` → `src/features/pieceSelection/`
- ファイル名変更:
  - `workflow-types.ts` → `piece-types.ts`
  - `workflowExecution.ts` → `pieceExecution.ts`
  - `workflowLoader.ts` → `pieceLoader.ts`
  - `workflowParser.ts` → `pieceParser.ts`
  - `workflowResolver.ts` → `pieceResolver.ts`
  - `workflowCategories.ts` → `pieceCategories.ts`
  - `switchWorkflow.ts` → `switchPiece.ts`
- 全テストファイルを新用語に対応（194ファイル変更、約3,400行の追加・削除）
- リソースディレクトリを更新:
  - `resources/global/*/pieces/*.yaml` を新用語で更新
  - 全プロンプトファイル（`*.md`）を更新
  - 設定ファイル（`config.yaml`, `default-categories.yaml`）を更新

## [0.4.1] - 2026-02-04

### Fixed

- 前のステップのレスポンスが後続ステップに誤ってバインドされるワークフロー実行バグを修正
  - `MovementExecutor`、`ParallelRunner`、`state-manager` を修正してステップ間のレスポンスを適切に分離
  - インタラクティブサマリープロンプトを更新してレスポンスの漏えいを防止

## [0.4.0] - 2026-02-04

### Added

- プロンプトの外部化: 内部プロンプトをすべてバージョン管理可能・翻訳可能なファイルに移行（`src/shared/prompts/en/`, `src/shared/prompts/ja/`）
- i18n ラベルシステム: UI ラベルを別ファイルに抽出（`labels_en.yaml`, `labels_ja.yaml`）し `src/shared/i18n/` モジュールを追加
- プロンプトプレビュー機能（`src/features/prompt/preview.ts`）
- ワークフローのフェーズ認識を改善するためのフェーズシステムをエージェントに注入
- 新しいデバッグログビューア（`tools/debug-log-viewer.html`）によるデバッグ機能の強化
- 包括的なテストカバレッジ:
  - i18n システムテスト（`i18n.test.ts`）
  - プロンプトシステムテスト（`prompts.test.ts`）
  - セッション管理テスト（`session.test.ts`）
  - Worktree 統合テスト（`it-worktree-delete.test.ts`, `it-worktree-sessions.test.ts`）

### Changed

- **BREAKING:** 内部用語の改名: `WorkflowStep` → `WorkflowMovement`、`StepExecutor` → `MovementExecutor`、`ParallelSubStepRawSchema` → `ParallelSubMovementRawSchema`、`WorkflowStepRawSchema` → `WorkflowMovementRawSchema`
- **BREAKING:** 不要な後方互換コードを削除
- **BREAKING:** インタラクティブプロンプトオーバーライド機能を無効化
- ワークフローリソースディレクトリを改名: `resources/global/*/workflows/` → `resources/global/*/pieces/`
- 可読性・保守性向上のためプロンプトを再構成
- 会話フローからタスク要件の不要なサマリー化を削除
- ワークフロー実行中の不要なレポート出力を抑制

### Fixed

- worktree 操作に関する `takt worktree` バグを修正

### Internal

- `src/shared/prompts/index.ts` にプロンプト管理を抽出（言語認識ファイルロード）
- `src/shared/i18n/index.ts` でラベル管理を一元化
- `tools/jsonl-viewer.html` に機能を追加
- 162ファイルにわたる大規模リファクタリング（約5,800行追加、約2,900行削除）

## [0.3.9] - 2026-02-03

### Added

- ワークフローカテゴリ化のサポート (#85)
  - `resources/global/{lang}/default-categories.yaml` にデフォルトカテゴリ設定を追加
  - `~/.takt/config.yaml` の `workflow_categories` でユーザー定義カテゴリを設定可能に
  - 無制限の深さでネストしたカテゴリをサポート
  - ワークフロー選択 UI でカテゴリベースのフィルタリングに対応
  - `show_others_category` と `others_category_name` の設定オプションを追加
  - `builtin_workflows_enabled` と `disabled_builtins` でビルトインワークフローのフィルタリングに対応
- エージェントなしのステップ実行: `agent` フィールドをオプションに (#71)
  - `instruction_template` のみでステップを実行可能（システムプロンプトなし）
  - インラインシステムプロンプトをサポート（ファイルが存在しない場合は agent 文字列をプロンプトとして使用）
- `takt add #N` がブランチ名に Issue 番号を自動反映 (#78)
  - Issue 番号をブランチ名に埋め込み（例: `takt/issue-28-...`）

### Changed

- **BREAKING:** パーミッションモード値をプロバイダー非依存形式に統一 (#87)
  - 新しい値: `readonly`, `edit`, `full`（`default`, `acceptEdits`, `bypassPermissions` を置き換え）
  - TAKT がプロバイダー固有のフラグに変換（Claude: default/acceptEdits/bypassPermissions、Codex: read-only/workspace-write/danger-full-access）
  - 全ビルトインワークフローを新しい値に更新
- ワークフロー名の変更:
  - `simple` ワークフローを `minimal` と `review-fix-minimal` に置き換え
  - 読み取り専用コードレビュー向けに `review-only` ワークフローを追加
- エージェントプロンプトを更新: レガシー対応禁止ルールを追加（後方互換ハックの禁止）
- ドキュメントの更新:
  - README.md と docs/README.ja.md を v0.3.8+ の機能で更新
  - CLAUDE.md をアーキテクチャの詳細と実装メモで大幅に拡充

### Internal

- カテゴリ管理のための `src/infra/config/loaders/workflowCategories.ts` を作成
- ワークフロー選択 UI のための `src/features/workflowSelection/index.ts` を作成
- カテゴリ表示サポートのため `src/shared/prompt/select.ts` を拡張
- ワークフローカテゴリの包括的なテストを追加（`workflow-categories.test.ts`, `workflow-category-config.test.ts`）

## [0.3.8] - 2026-02-02

### Added

- ワークフロー/設定ファイルパスを指定する CLI オプションを追加: `--workflow <path>` と `--config <path>` (#81)
- CI フレンドリーなクワイエットモードによる最小限のログ出力 (#70)
- ワークフロー実行テスト用のモックシナリオサポート
- 包括的な統合テスト（7テストファイル、約3000行のテストカバレッジ）

### Changed

- ルール評価の改善: `detectRuleIndex` が最初のマッチではなく最後のマッチを使用するよう変更 (#25)
- `ai_fix` ステップを大幅に改善:
  - リトライ試行回数を表示する `{step_iteration}` カウンターを追加
  - 明示的な修正手順を定義（Read → Grep → Edit → Test → Report）
  - coder エージェントがレビュアーのフィードバックを仮定より優先するよう変更
- README とドキュメントを更新: CLI 使用法と CI/CD の例を明確化

### Fixed

- ワークフローのロード優先順位を修正（ユーザーワークフローがビルトインより優先されるよう変更）
- テストの安定性を改善（不安定なテストをスキップ、ai_fix テストを更新）
- Slack 通知設定を修正

### Internal

- インストラクションビルダーをリファクタリング: コンテキスト組み立てとステータスルールロジックを抽出 (#44)
- DRY な git コミット操作のために `src/infra/task/git.ts` を導入
- `getErrorMessage()` によるエラーハンドリングの統一
- コードベース全体で `projectCwd` を必須化
- 非推奨の `sacrificeMode` を削除
- 一貫性のため 35 ファイルを更新（`console.log` → `blankLine()` 等）

## [0.3.7] - 2026-02-01

### Added

- パイプライン/非インタラクティブモード実行のための `--pipeline` フラグを追加 (#28)
- パイプラインモードで `--task` と `--issue` オプションの両方を使用可能に

### Changed

- ログファイルの命名を base36 から人間が読める `YYYYMMDD-HHmmss-random` 形式に変更 (#28)
- `--task` オプションの説明を更新: GitHub Issue の代替であることを明確化

## [0.3.6] - 2026-01-31

### Fixed

- `ai_review` ワークフローステップに `pass_previous_request` 設定が正しく含まれていない問題を修正

## [0.3.5] - 2026-01-31

### Added

- worktree の確認プロンプトをスキップする `--create-worktree <yes|no>` オプションを追加

### Fixed

- 各種 CI/CD の改善と修正 (#66, #67, #68, #69)

## [0.3.4] - 2026-01-31

### Added

- 変更なしのコードレビュー向けレビューオンリーワークフローを追加 (#60)
- 各種バグ修正と改善 (#14, #23, #35, #38, #45, #50, #51, #52, #59)

## [0.3.3] - 2026-01-31

### Fixed

- `takt add #N` がIssue内容をAI要約に通してしまい、タスク内容が壊れる問題を修正 (#46)
  - Issue参照時は `resolveIssueTask` の結果をそのままタスクとして使用するように変更

## [0.3.1] - 2026-01-31

### Added

- インタラクティブタスク計画モード: `takt`（引数なし）が実行前に AI との会話でタスク要件を整理 (#47, #5)
  - takt 再起動をまたいだセッション継続
  - コードベース調査のための読み取り専用ツール（Read, Glob, Grep, Bash, WebSearch, WebFetch）
  - 会話中のコード変更を防止するプランニング専用システムプロンプト
  - 確認して実行する `/go`、終了する `/cancel`
- レビュアー/スーパーバイザーのエージェントテンプレートに Boy Scout Rule の徹底を追加

### Changed

- CLI をスラッシュコマンド（`takt /run-tasks`）からサブコマンド（`takt run`）に移行 (#47)
- `/help` と `/refresh-builtin` コマンドを削除、`eject` を簡素化
- SDK オプションビルダーが定義済みの値のみを含むよう変更（ハング防止）

### Fixed

- `model: undefined` などの undefined オプションをキーとして渡した際に Claude Agent SDK がハングする問題を修正

## [0.3.0] - 2026-01-30

### Added

- ルールベースのワークフロー遷移と5段階フォールバック評価 (#30)
  - タグベースの条件: エージェントが出力する `[STEP:N]` タグをインデックスでマッチング
  - `ai()` 条件: エージェント出力に対してフリーテキストの条件を AI が評価 (#9)
  - 並列ステップ結果を集約する `all()`/`any()` 条件 (#20)
  - 5段階の評価順序: aggregate → Phase 3 tag → Phase 1 tag → AI judge → AI fallback
- 3フェーズのステップ実行モデル (#33)
  - Phase 1: メイン作業（コーディング、レビュー等）
  - Phase 2: レポート出力（`step.report` が定義されている場合）
  - Phase 3: ステータス判定（タグベースのルールが存在する場合）
  - コンテキスト継続のためフェーズをまたいでセッションを再開
- `Promise.all()` による並列サブステップの同時実行 (#20)
- GitHub Issue 統合: Issue 番号でタスクを実行・追加（例: `takt #6`）(#10, #34)
- リアルタイムストリーミング書き込みによる NDJSON セッションログ (#27, #36)
- ビルトインリソースを npm パッケージに内包し、カスタマイズ用の `/eject` コマンドを追加 (#4, #40)
- ステップごとのファイル編集制御のための `edit` プロパティ
- ルールマッチング方法の可視化とログ記録
- YAML の `report.format` からレポート出力を自動生成
- ビルトインワークフローでの並列レビューと仕様適合チェックをサポート (#31)
- WorkflowEngine モックの統合テスト (#17, #41)

### Changed

- レポートフォーマットを自動生成に統一: レポートの手動 `order`/`instruction_template` を削除
- `gitdiff` レポートタイプを削除し、フォーマットベースのレポートに移行

### Fixed

- レポートディレクトリに `.takt/reports/` プレフィックスが正しく含まれるよう修正 (#37, #42)
- eject.ts の未使用インポートを削除 (#43)

## [0.2.3] - 2026-01-29

### Added

- ブランチ管理のための `/list-tasks` コマンドを追加（マージ試行、マージ＆クリーンアップ、削除）

### Changed

- Claude Code SDK がメインリポジトリに遡らないよう、分離実行を `git worktree` から `git clone --shared` に移行
- クローンのライフサイクル変更: タスク完了後の自動削除を廃止。クリーンアップには `/list-tasks` を使用
- `worktree.ts` を `clone.ts` と `branchReview.ts` に分割
- SDK の遡りを防ぐためクローンから origin リモートを削除
- 全ワークフローのレポートステップに Write パーミッションを付与
- `git clone --shared` を `--reference --dissociate` に変更

### Fixed

- バージョンをハードコードの `0.1.0` ではなく `package.json` から読み込むよう修正 (#3)

## [0.2.2] - 2026-01-29

### Added

- タスクブランチへの指示実行のための `/review` インストラクトアクションを追加
- ブランチ名用の英語スラッグへの AI によるタスク名サマリー化
- Worktree のセッション継承
- 実行ルールのメタデータ（git コミット禁止、cd 禁止）

### Changed

- ステータス出力ルールのヘッダーを自動生成
- インストラクションに worktree の変更コンテキストを自動包含
- マージ試行をスカッシュマージに変更
- `expert-review` を `expert-cqrs` に改名、共通レビュアーを `expert/` に統合

### Fixed

- 異常終了時にタスクが誤って `completed` に遷移する問題を修正

## [0.2.1] - 2026-01-28

### Added

- 言語設定（`ja`/`en`）を追加
- `/add-task` での複数行入力をサポート
- `/review-tasks` コマンドを追加
- 数値入力から矢印キーによるカーソルベースのメニュー選択に変更
- `answer` ステータス、`autoCommit`、`permission_mode`、詳細ログオプションを追加

### Fixed

- 複数の worktree 関連バグを修正（ディレクトリ解決、セッション処理、作成フロー）
- ESC キーでワークフロー/タスク選択をキャンセル可能に

## [0.2.0] - 2026-01-27

### Added

- `.takt/tasks/` からのタスクをファイルシステムポーリングで自動実行する `/watch` コマンドを追加
- ビルトインリソース更新のための `/refresh-builtin` コマンドを追加
- インタラクティブなタスク作成のための `/add-task` コマンドを追加
- デフォルトワークフローを強化

## [0.1.7] - 2026-01-27

### Added

- ワークフロー検証のためのスキーマパーミッションサポートを追加

## [0.1.6] - 2026-01-27

### Added

- テスト用のモック実行モードを追加

### Changed

- `-r` オプションを省略、デフォルトを会話継続モードに変更

## [0.1.5] - 2026-01-27

### Added

- 合計実行時間の出力を追加

### Fixed

- ワークフローが実行中に意図せず停止する問題を修正

## [0.1.4] - 2026-01-27

### Changed

- ワークフロープロンプトを強化
- 遷移プロンプトをワークフロー定義に統合

## [0.1.3] - 2026-01-26

### Fixed

- イテレーションが停滞する問題を修正

## [0.1.2] - 2026-01-26

### Added

- Codex プロバイダーのサポートを追加
- ステップ/エージェントごとのモデル選択
- パーミッションモード設定
- 分離タスク実行のための Worktree サポート
- プロジェクト `.gitignore` の初期化

### Changed

- エージェントプロンプトを改善

## [0.1.1] - 2026-01-25

### Added

- npm 公開のための GitHub Actions ワークフローを追加

### Changed

- インタラクティブモードを削除、CLI を簡素化
