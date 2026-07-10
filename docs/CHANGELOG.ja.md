# Changelog

[English](../CHANGELOG.md)

このプロジェクトの注目すべき変更はすべてこのファイルに記録されます。

フォーマットは [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づいています。

## [0.51.0] - 2026-07-11

### Added

- オートルーティング: `provider: auto` (#921, #964)。TAKT がステップごとにプロバイダ/モデルを選択できるようになりました。`auto_routing` ブロックに `strategy`（`cost`・`balanced`・`performance`）、各ステップを分類する軽量な `router` モデル、名前付きの `candidates`（provider + model + `cost_tier`）を設定します。`rules.tags` でステップタグを特定の candidate へ決定的に固定できます。ルーティングの決定は `.takt/events/` 配下に NDJSON としてローカル記録されるだけでアップロードはされません。ローカル記録は `telemetry.routing_decisions` または `takt telemetry status|enable|disable` で制御できます。
- exec 入力での画像添付 (#934, #936)。exec の入力行を編集中に、macOS では `/paste-image` または `Ctrl+V` でクリップボード画像を添付でき、対応ターミナルからの OSC 1337 インライン画像も受け付けます。TAKT は `[Image #N]` プレースホルダを挿入し、Assistant メッセージや `/go` のノートでそれを参照するとそのリクエストに画像が送られます。`/go` 実行時には参照された画像が生成タスクスペックへコピーされます。対応フォーマットは PNG・JPEG・GIF・WebP で上限は 10 MiB。ネイティブ画像入力のないプロバイダにはローカルパス参照としてプロンプトに渡されます。
- `session: compact` モード (#994, #995)。ステップと並列サブステップで `session: compact` を指定すると、保存済みペルソナセッションを resume したうえで Phase 1 の前にプロバイダへセッション圧縮を依頼し、長時間走るペルソナをコンテキスト上限内に保てます。圧縮は Phase 1 前のみ実行され、圧縮 capability のないプロバイダはそのまま続行、圧縮失敗時は warning を出して未圧縮セッションで継続します。
- Finding Contract マネージャのプロバイダ/モデル指定 (#970, #1008)。`finding_contract.manager` に Finding Manager 合成ステップ専用の `provider` / `model` を指定できるようになりました。設定時は `provider_routing`、非推奨の `persona_providers`、ワークフローデフォルト、解決済み入力プロバイダ/モデルより優先されます。

### Changed

- Finding Manager の機械分類 (#1007)。決定可能な raw finding — 解決確認と、open finding への location+familyTag 完全一致 — をコードで分類し、マネージャ LLM には残余の判断だけを（スリム化した台帳とともに）渡すようになりました。残余ゼロかつ異議申告がなければ LLM 呼び出し自体をスキップします。実測ベンチではマネージャが毎ラウンド約 200 KB の台帳を運ぶ最大のトークン消費源でした。
- `for-local-llm` ファミリーで `implement` の行き詰まりを ABORT ではなく `plan`（再計画）へ流すようにしました (#1009)。`write_tests` と `fix` の既存挙動に揃えたものです。ABORT はループモニターの裁定・要件不明確・レビュー対立に限定されます。
- 同梱 SDK を更新: `@openai/codex-sdk` 0.144.1 / `@anthropic-ai/claude-agent-sdk` 0.3.206 (#1015)。同梱の Codex CLI が GPT-5.6 モデルファミリー（`gpt-5.6-sol`・`gpt-5.6-terra`・`gpt-5.6-luna`）を認識するようになり、codex プロバイダの `model` に指定できます。

### Fixed

- OpenCode の無音タイムアウト時にセッションを検死し、プロバイダの 429 を `rate_limited` として分類 (#985, #1010)。OpenCode サーバはプロバイダの 429 を内部リトライで握り `session.error` を流さないため、レート制限されたセッションが進捗ゼロのストールに見え、無音ウォッチドッグがエンジンのレート制限バックオフへ接続せずに落としていました。無音タイムアウトで abort した場合に限り、セッションの最後の assistant メッセージを（5 秒の上限付きで）照会し、429 系エラーを `rate_limited` として返します。
- Finding Contract の異議申告が `language: ja` でも機能するようになり、index 状態由来の finding を防止 (#1012, #1014)。FC の指示文が英語固定で ja では異議申告の入口が細かったため、機械照合されるトークン（`## Disputed Findings`・フィールド名）は英語のまま散文をローカライズしました。正当な異議を封じていた coder ペルソナの「レビュワーの指摘は絶対。反論しない」という姿勢を証拠の規律へ書き換えました。git ルールに「index/staging の状態を証拠として扱わない」を追加し、TAKT 管理の実行で充足不能な「このファイルをコミットせよ」finding を防ぎます。
- 異議申告ルートで陳腐化した finding をエンドツーエンドでカバー (#993)。異議申告ガイダンスが現行コードと矛盾する finding（再修正の前に実態と照合し、新しい file:line 証拠で異議を申告する）をカバーするようになり、review-fix のループ判定は「修正は着地したのに finding が残り続ける」状態を、中断ではなく再計画+異議申告で解ける findings 側のデッドロックとして扱います。
- 実走ベンチ運用からの夜間堅牢化 (#999)。ユーザー設定の部分的な `provider_profiles` がデフォルトマップ全体を置き換えるのではなくプロバイダ単位のオーバーレイになりました。`edit: true` が `edit` 権限フロアを供給し、編集を宣言したステップが読み取り専用ツールマップで走ることがなくなりました。ツール名をローテーションする退化ループを止める呼び出し単位のツールエラーバジェット（25、リセットなし）と、純テキスト断片のスピンループを止める assistant メッセージサイクル上限を追加しました。

### Internal

- ファセットガイダンスの明確化: 出力契約と境界 (#1013)、アクターと認証のナレッジ (#1004)、宣言的バリデーション (#1000)、例外変換の境界 (#998)、MCP の worktree/autoPr 説明 (#997)。

## [0.50.0] - 2026-07-06

### Added

- MCP サーバーエントリポイント `takt-mcp` (#938, #943)。TAKT を stdio Model Context Protocol サーバーとして起動できるようになりました。MCP クライアント（Codex、Claude Code など）から `takt add` / `takt run` を経由せずに TAKT を操作できます。公開ツールは 3 つです。`takt_enqueue_task`（`.takt/tasks.yaml` に pending タスクを保存）、`takt_create_issue_and_enqueue_task`（設定済み issue プロバイダで issue を作成し、その番号でタスクを積む）、`takt_run_next_task`（次の pending タスクを取得して実行）。各ツールの `cwd` は `realpath` で解決され、サーバーの許可プロジェクトルート内に収まる必要があります。Codex には `codex mcp add takt -- takt-mcp` または `[mcp_servers.takt]` ブロックで登録します。ツールスキーマの詳細は CLI Reference を参照してください。
- ACP エージェントエントリポイント `takt-acp` (#913, #916)。TAKT を stdio JSON-RPC 上の Agent Client Protocol エージェントとして起動できるようになりました。ACP 互換クライアントから起動します。`session/prompt` は既定で enqueue-first です。「タスクを積んで」のようなプロンプトは `.takt/tasks.yaml` に pending タスク（`worktree: true`）を追加し、後で `takt run` で実行できます。「今すぐ実行」のような明示的なプロンプトのみ直接実行します。`initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` をサポートし、`session/new` で渡された stdio MCP サーバーはワークフロー実行へ引き継がれます。
- `for-local-llm` ワークフローファミリー (#958, #974, #982)。ローカルまたは非力なモデル向けに調整した 5 つのワークフロー（`takt-default-for-local-llm`、`frontend-for-local-llm`、`backend-for-local-llm`、`backend-cqrs-for-local-llm`、`dual-for-local-llm`）を追加。それぞれ 4 つ（dual は 5 つ）の並列ディープレビュアーが Finding Contract（レジャー、解決確認、ディスピュート裁定）を背景に走り、フラットなマージレディネス最終ゲートを備えます。コンパイルを通過する挙動上の欠陥を捉える新しい `implementation-semantics` レビュアー（ペルソナ、ナレッジ、インストラクション、finding-contract 出力契約）を追加。レビュー専用の `peer-review-for-local-llm` ワークフローも同梱します。
- `cli` ワークフロー (#947)。CLI 開発向けワークフローです（plan → write_tests → draft（実装 + AI セルフレビュー）→ peer-review（並列レビュアー + fix）→ supervise → COMPLETE）。
- Finding Contract のディスピュート/waiver ライフサイクル (#969)。妥当だが修正できない finding に対し、コーダーが固定見出し `## Disputed Findings` の下でディスピュート（finding id / 理由 / file:line）を宣言できるようになりました。findings マネージャは finding を waive（理由と根拠を記録してブロッキング集合から除外）するか、ディスピュートを却下（open のままブロッキング継続）します。ゲートは従来通り `findings.open.count == 0` 条件を保つため、妥当だが修正不能な finding でデッドロックしていた実行が解けます。
- エンジン評価条件のための `when()` 構文 (#977)。ルール条件内の決定的な状態式を、既存の `ai()` / `all()` / `any()` ファミリーと同様に `when(...)` で明示的に宣言するようになりました（例: `condition: when(findings.conflicts.count > 0)` や `approved && when(findings.open.count == 0)`）。ルールレベルの `when:` キーは式を自動的にラップするシュガーです。カスタムワークフローについては後述の BREAKING を参照してください。
- 最終ゲート用のプロバイダルーティングタグ (#954)。ビルトインの最終ゲートステップに `final-gate` タグが付与され、`provider_routing.tags.final-gate` でマージレディネスゲートだけを他のレビューステップと独立して強いプロバイダ/モデルへルーティングできます。
- マージレディネスレビューゲート (#949)。ビルトインの開発・メンテナンスワークフローに、マージ可能かどうかだけを判定する並列の最終マージレディネスゲート（`merge-readiness-final-gate` / `merge-readiness-dual-final-gate`）を追加しました。
- OpenCode ネイティブ `json_schema` 構造化出力 (#965) と、レビュアーが不正な構造化出力を出した際の 1 回限りの是正リトライ (#963)。OpenCode レビュアーステップは、手書き JSON に頼らずキー構造をソースで強制する OpenCode ネイティブの `format: json_schema` で構造化出力を要求するようになりました。それでも不正な JSON が出た場合、失敗させる前に同一セッションへ一度だけ修正済みペイロードの再出力を求めます。

### Changed

- **BREAKING:** 決定的なルール条件に `when()` ラッパーが必須になりました (#977)。ルール `condition` 内の裸の比較式（例: `findings.open.count == 0`）はエンジン評価される事実ではなく、単なる散文タグ条件として扱われます。裸の式を含む集約ガードは移行ヒント付きで設定エラーになります。これは、`coverage >= 80%` のような散文を暗黙にマッチ不能なデッドルール化していた脆い比較演算子ヒューリスティックを置き換えるものです。旧ヒューリスティックに依存していたカスタムワークフローは、決定的な句を `when(...)`（またはルールの `when:` キー）でラップする必要があります。ビルトインは移行済みです。
- **BREAKING:** `-with-fc` ワークフロー系統を削除 (#974)。`takt-default-with-fc` と `peer-review-with-fc`（0.47.0 で追加）は、新しい `for-local-llm` ファミリーに置き換えられました。これが Finding Contract のラインナップになります。旧ワークフロー名への参照は更新してください。
- fixer が「続行不能」で実行を中断しなくなりました (#986)。fixer がブロッカーを諦めた場合、実行全体を捨てる代わりに planner へ戻して再分解します（planner の席は強いモデルにルーティング可能）。新しい再計画サイクルのループモニターは、連続する再計画が同じ行き詰まりを繰り返したときだけ、人間向けの引き継ぎサマリーとともに中断します。5 つの開発ワークフローに適用されます。
- Codex の `approval_policy` を `never` に固定。TAKT は Codex を非対話で実行するためエスカレーションを承認する人間がいません。そのためサンドボックスモードが唯一の書き込み境界となり、`readonly` は書き込みを完全にブロック、`edit`/`full` は従来通りに動作します（Codex の既定承認ポリシーが読み取り専用サンドボックスを越えてエスカレーションを自動承認する挙動を防止）。
- Codex のモデル能力チェックをプロバイダへ委譲 (#983)。

### Fixed

- OpenCode のアイドルウォッチドッグがストールしたセッションで発火するようになりました (#984)。10 分のアイドルウォッチドッグは、サーバー全体のイベント（LSP、ファイルウォッチャー、兄弟セッション）でタイマーがリセットされるためストールを見逃すことがありました。リセットをそのセッション自身のイベントに限定しました。
- OpenCode セッションがステップフェーズ間でプロンプト単位のツール制限により保持されるようになり (#948)、ワークスペース外拒否は有効かつ非致命的に保たれます (#957)。
- OpenCode 構造化出力のリカバリ: ネイティブ構造化出力が生成されないときはフォーマットなしのリトライにフォールバックし (#967)、ゲートウェイが `json_schema` を拒否したときも復帰、空または誤字の raw-finding の location/suggestion フィールドは未設定として扱います (#962)。
- finding-contract の解決が到達可能になり、ガード付きタグルールをサポート (#961)。ディスピュートガイダンスは open な finding が存在するときだけ注入されます (#973)。
- Cursor CLI の設定ディレクトリが実行間で保持されるようになりました (#960)。
- シンボリックリンクされた stdio エントリポイントを実パスへ解決 (#955)。`takt-mcp` / `takt-acp` をシンボリックリンク経由で起動しても動作します。
- レポートフェーズの失敗と空の Phase 1 出力がソフトエラーになりました (#907, #911, #927)。レポート生成の失敗は中断せず Phase 3（ステータス判定）へ継続し、空の Phase 1 出力はエラーとして検出され後続フェーズが無内容で走らないようにし、レポートのフォールバック経路を追加しました。
- 分離クローンの fetch が、親リポジトリの HEAD が対象ブランチにある場合に失敗しなくなりました (#924)。fetch 前に HEAD をデタッチします。
- OpenCode の readonly・ツールなしフェーズでの `bash` ツール処理を修正 (#918, #919)。
- `takt list` の追加指示 + リキューフローを修正 (#942)。
- フルエリア監査に基づき判定・findings・OpenCode 処理を堅牢化 (#981)。

### Internal

- CQRS+ES のナレッジとガイダンスを強化 (#925, #940, #941, #979, #988)。
- プロンプト品質ツール: promptfoo ベースのファセット品質 eval (#946) と、implementation-semantics レビュアー向けの rescan-semantics eval スイート (#951, #952, #959)。
- レビュアーはレビューレポートに再スキャンの証跡を記載する必要があり (#951)、published-state の不変性とファミリーレベルの finding 集約を学習し (#953)、ガード付き Record を指摘しなくなりました (#968)。
- review / write-tests / test-policy のファセット契約を厳格化 (#915, #917, #932, #944, #966, #987)。
- Codex: テストゲートの並列化 (#920)、MCP タスクワークフローと auto-PR の判断 (#972)。
- `when()` ヘルパーをコーディング規約に沿って整理 (#978)。

## [0.49.0] - 2026-06-28

### Added

- `takt exec` — ワークフロー YAML を書かずにマルチエージェントを即座に実行するインスタントモード (#880, #893, #908)。対話セッションを開始し、Assistant エージェントがリクエストを明確化、`/go` で会話をワークフローに変換、Worker エージェントがタスクを実装、Review エージェントがレビュー、Replanning エージェントが必要に応じてユーザーに方針確認を行い、ループ検出が非生産的な繰り返しを防止します。ビルトインプリセット (`backend`, `frontend`, `dual`, `research`) を同梱。`/setup` でエージェント、ループ閾値、プリセット、参照ファセットを編集でき、変更は `~/.takt/exec.yaml` に保存されます。プリセットはプロジェクトまたはグローバルスコープで保存・削除でき、`/setup` メニューからスタンドアロンのワークフロー YAML としてエクスポートも可能です。
- `session_key` ワークフローフィールド。通常のエージェントステップ、並列サブステップ、`loop_monitors.judge` で `session_key` を指定して、ステップ間でペルソナセッションを共有または分離できるようになりました。ランタイムキーは `session_key` に解決済みプロバイダサフィックスを付加して構築されます（例: `shared-coder:claude`）。省略時は従来通りペルソナキーまたはステップ名が使用されます。
- 外部コントラクト検証ポリシー (#891)。コンパイル成功やモック成功を外部サービスコントラクトの証明として扱うことを防止する新ポリシールールを追加。`existing-system-respect`、`review`、`testing` ポリシーに追加されました。

### Fixed

- チームリーダーの分解ターン制限 (#904, #906)。チームリーダーの `decomposeTask` および `requestMoreParts` 呼び出しが、大規模プロジェクトで「最大ターン数 (15) に到達」エラーで失敗する問題を修正。読み取り専用の分解呼び出しからハードコードされたターン制限を削除しました。
- OpenCode 利用不可ツールのループ検出 (#886)。`UnavailableToolLoopDetector` がエラー以外のすべてのツール状態（`running` を含む）でリセットされていた問題を修正。`completed` 状態のみでカウンターをリセットするように変更しました。
- OpenCode のツールなしフェーズでのツール拒否 (#887)。ツールなしフェーズでワイルドカード拒否を使用するように変更し、ツールフリー実行フェーズでのツール漏れを防止しました。
- OpenCode ランタイムツールリストの極性 (#890)。OpenCode ランタイム命令がネガティブリストからポジティブリストに変更され、利用可能なツールの混乱を低減しました。
- OpenCode の存在しないツール呼び出し (#892)。OpenCode のデフォルトの few-shot 例に含まれる存在しない `list` および `task` ツールの呼び出しを防止するため、カスタム TAKT エージェントを定義しました。

### Internal

- Product Hunt ランディングページを `docs/index.html` に追加。
- ドキュメント更新: TAKT ランタイムアセットの境界を明確化、Headroom はオプション、`--no-telemetry` オプションの追記。
- `review-web` プロバイダオプションを削除（`review-readonly` に統合）。

## [0.48.0] - 2026-06-21

### Added

- プロバイダ `base_url` サポート (#867)。`provider_options.claude.base_url` および `provider_options.codex.base_url` でカスタム API エンドポイントを設定可能に。グローバル・プロジェクト・ワークフローの各レベルで設定できる。セキュリティ上、プロジェクト/ワークフロー設定ではループバック以外の URL はブロックされる。
- チームリーダー `inspect_tools` (#857, #858)。`team_leader` ブロックで `inspect_tools` を指定し、タスク分解時にリーダーが使えるツールを制限可能に。`read`、`glob`、`grep` をサポート。OpenCode と Claude プロバイダで利用可能。
- チームリーダーパートタグ (#855)。チームリーダーが分解したワーカーパートに `tags` を付与可能に。`provider_routing.tags` によるパートレベルのプロバイダ/モデル切り替えが可能。
- Nix flake パッケージング (#837)。TAKT を Nix flake として提供開始。`x86_64-linux`、`aarch64-linux`、`x86_64-darwin`、`aarch64-darwin` で再現可能なビルドを提供。Node.js 22 と Bun を含む dev shell 付き。
- `backend-maintenance` ビルトインワークフロー。本番システム保守向けの厳密なワークフローテンプレート。複数レビューフェーズ（アーキテクチャ、テスト、セキュリティ、QA、ピュアレビュー、コーディングレビュー）、ループモニター、デュアルスーパーバイザーによる最終承認を備える。
- `token-usage.sh` 分析ツール。`tools/` 配下のシェルスクリプトで、TAKT 実行のトークン消費量を集計。上位 N 件のラン表示、ステップ別内訳、キャッシュ率、CSV エクスポートに対応。

### Fixed

- OpenCode の no-tools フェーズでツールガイダンスを省略 (#874)。`allowedTools` が空のフェーズではツール命名ガイダンスを返さないように修正。
- ワークツリークローンの `.takt/.gitignore` 処理を修正 (#862, #864)。deny-by-default テンプレートがクローンに正しく作成され、`.takt/runs/` 配下のランタイム成果物がコミットされないように修正。
- E2E テストの安定性向上。mock E2E テストで `git` 認証プロンプトによるハングを防止（`GIT_TERMINAL_PROMPT=0`）。プロバイダテスト用に GitHub credential helper を isolated gitconfig に継承。

### Internal

- レビュー・テスト facet の強化 (#859, #868)。テストポリシーに absence-only テストや非継承値テストの REJECT 条件を追加。E2E knowledge facet を新設。review-test instruction を更新。
- ワークフローカテゴリに `backend-maintenance` の順序を追加。
- Codex faceted-prompting 依存を更新 (#863)。

## [0.47.0] - 2026-06-18

### Added

- Finding Contract — レビューワークフロー向けの構造化された指摘ライフサイクル管理 (#816, #826, #839, #840, #842, #845)。レビュー指摘が正式な台帳（`findings-ledger.json`）でライフサイクル状態（`new`・`persists`・`resolved`・`reopened`）、重要度、重複排除とともに追跡されるようになった。専用の `findings-manager` ペルソナが複数レビュアーの生の指摘を台帳と照合し、安定した ID（`F-0001`、`F-0002`、…）を割り当てて競合を検出する。`src/core/workflow/findings/` に reconciler・store・manager-runner・validation を新設し、全レビュータイプ（coding・architecture・security・QA・frontend・testing・terraform・CQRS/ES・pure・AI antipattern）に finding-contract 出力契約を追加した。Finding Contract 対応の新ワークフロー `takt-default-with-fc` と `peer-review-with-fc` を同梱。ワークフロー YAML に `finding_contract` セクションを追加することで有効化できる
- ペルソナ・タグ・ステップ名による `provider_routing` 設定を追加 (#844, #846)。新しい `provider_routing` 設定セクションで、3 つの次元でプロバイダー/モデル/provider_options を選択できる。`personas`（生のペルソナキー別）、`tags`（ステップタグ別）、`steps`（ステップ名別）。解決優先順位はステップ直接指定 > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > 非推奨の `persona_providers` > ワークフロー > CLI。プロジェクト（`.takt/config.yaml`）またはグローバル（`~/.takt/config.yaml`）で設定可能
- ビルトインワークフローの全ステップにタグを追加 (#851)。すべてのビルトインワークフローステップに `tags` 配列（例: `plan`・`coding`・`review`・`implementation`・`edit`）を付与した。タグは `provider_routing.tags` の主キーで、個別のステップ名ではなくカテゴリ単位でプロバイダー/モデルをオーバーライドできる。並列サブステップのタグもサポート
- OTel スパン向けのトレース発見性を追加 (#843, #847)。新しい `traceDiscovery` モジュールが、構造化された `WorkflowTraceDiscovery` オブジェクト（サービス名・runId・ワークフロー名・タスクメタデータ・Git ブランチ/ベース情報）と検索可能なクエリ文字列を構築し、Grafana Tempo などの外部オブザーバビリティツールとのワークフロー実行の相関を可能にする
- トレースタスクメタデータのエンリッチメントを追加 (#827, #829)。タスクメタデータ（ソース・Issue/PR 番号・ブランチ・スラッグ・要約）が構造化された `WorkflowTraceTaskMetadata` として抽出され、OTel スパンとトレース発見出力に伝播されるようになった
- provider options とファセット向けの名前付きリソースリゾルバーを追加 (#820, #824)。セキュアな 3 層リゾルバー（`namedResourceResolver.ts`）が `.takt/provider-options/` → `~/.takt/provider-options/` → ビルトイン `provider-options/` ディレクトリをベア名で拡張子フォールバック（`.yaml`/`.yml`）付きで検索し、パストラバーサルを検証しシンボリックリンクが許可ディレクトリ内に留まることを確認する。新しい `extends` キーワードで使用される

### Changed

- **BREAKING:** `provider_options.$ref` を `provider_options.extends` にリネーム (#820, #824)。ステップ/ワークフローの `provider_options` で共有 YAML ファイルを参照していた `$ref` キーが `extends` にリネームされた。値は相対ファイルパス（例: `$ref: provider-options/edit.yaml`）ではなく、3 層の名前付きリソースリゾルバーで解決されるベア名（例: `extends: edit`）になった。`$ref` を使用しているカスタムワークフローは更新が必要。ビルトインの provider options ファイルは `builtins/{lang}/workflows/provider-options/` から `builtins/{lang}/provider-options/` に移動した。ユーザーオーバーライドは `.takt/provider-options/` または `~/.takt/provider-options/` に配置する
- **BREAKING:** `persona_providers` を非推奨化し `provider_routing` を推奨 (#844, #846)。`persona_providers` 設定キーは引き続き動作するが非推奨となった。表示名でマッチするため脆弱であり、`provider_routing.personas` は代わりに生のペルソナキーでマッチする。移行方法: `persona_providers` のエントリを `provider_routing.personas` に移動する
- レポートフェーズのツール呼び出し検出を強化。レポートフェーズがプロバイダーのツール呼び出し（このフェーズでは禁止）を積極的に検出・拒否し、壊れた出力を黙って生成する代わりにリトライ可能なエラーを返すようになった。レポートファイル書き込みロジックを共有 `report-writer.ts` モジュールに抽出
- レビューとコーディングのポリシーを強化。レビューポリシーにコントラクトカバレッジ・コントラクト整合性・仕様完全性・要件アンカリング・解決判断に関する新しい REJECT 条件を追加。これまで欠落していたレビューワークフローにコーディングポリシーを接続した (#848)
- スーパーバイザーインストラクションを通常モード・メンテナンスモードの両方で全面改訂し、スコーピングと検証基準を明確化
- 知識ファセットを拡充: アーキテクチャパターン、バックエンドの例外変換スコープ、CQRS/ES ドメインパターン

### Fixed

- Cursor CLI の並列実行時に cli-config.json リネームの ENOENT が発生する問題を修正 (#802, #819)。Cursor CLI が並列レビュアーステップ実行時に内部の `cli-config.json.tmp` → `cli-config.json` リネームが競合し ENOENT で断続的に失敗することがあった。致命的なプロバイダーエラーとして扱う代わりに、指数バックオフ付きリトライ（最大 8 回、1〜30 秒遅延）を行うようにした
- OpenCode の利用不可ツールループを修正 (#822)。OpenCode プロバイダーがエージェントの利用不可ツール繰り返し呼び出しで無限ループに陥ることがあった。新しい `UnavailableToolLoopDetector` が連続 2 回の利用不可ツールエラーでセッションを中断し、明確な失敗メッセージを表示する
- レビュー指摘を元の要件にアンカリングするよう修正 (#830)。レビュアーが指摘を評価する際に元のタスク要件から逸脱することがあった。インストラクションと出力契約で、レビュー判断をプランおよび元のタスク記述にアンカリングすることを強制するようにした

### Internal

- AI antipattern レビューポリシーを finding-contract 出力契約を持つ独立ファセットとして再構成
- テストポリシーファセットを追加し、不在のみテストに対するガイダンスを含む
- README にステータスバッジを追加 (#835)
- finding contract・provider routing・trace discovery・trace task metadata・report phase retry・named resource resolver・workflow spans 等をカバーする 20 以上の新テストファイル
- 設定とワークフローのドキュメントを `provider_routing` と `extends` に対応して更新
- `WorkflowEngineSetup` を抽出してエンジン初期化をクリーン化
- `WorkflowRunLoop` に失敗メタデータとコマンドゲートの改善を追加
- レパートリー pack-summary を名前付きリソース解決と `extends` 参照に対応して書き直し

## [0.46.0] - 2026-06-13

### Added

- OTLP エクスポートにプロバイダーサブプロセスの span ネストと実行中トレースの発見性を追加 (#808, #812, #814)。`observability.enabled: true` と `OTEL_EXPORTER_OTLP_ENDPOINT` が揃った場合のみ、既存のローカル exporter と並走して span と metric を OTLP HTTP で送信する。`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` による個別 endpoint 上書きも標準環境変数として利用できるが、TAKT 独自の OTLP config キーは追加していない。0.42.0 の「標準 `OTEL_*` 環境変数で自前の collector に接続する」という記述は、#753 以降 `spanProcessors` / `metricReaders` を明示指定したことで成立していなかったため、本変更で実際に送信できるようにした。さらに、起動するプロバイダーのサブプロセスへ W3C トレースコンテキストを伝播するようにし、各プロバイダー CLI の span が独立したトレースにならず親ワークフローのトレース配下にネストするようにした (#812)。あわせて、長時間続くルート span が閉じる前でも実行中のワークフローを Grafana Tempo で発見できるよう、短命な `workflow_start.<name>` span を出力する (#814)
- OpenCode のツール許可リストと共有 `provider_options` ファイルを追加 (#804)。`provider_options.opencode.allowed_tools` で、ステップやワークフローが利用できる OpenCode ツールを小文字のツール名（例: `read`・`glob`・`grep`・`bash`・`websearch`・`webfetch`）で絞り込める。`provider_options` ブロックはワークフローファイルからの相対パスで共有 YAML ファイルを `$ref` 参照できるようになり、インライン値が一致するリーフを上書きする。再利用できるビルトイン `provider-options/{edit,review-files,review-readonly,review-web}.yaml` プリセットも同梱した
- Kiro のステップ単位カスタムエージェントを追加 (#796)。`provider_options.kiro.agent` で、ステップ・ワークフロー・ペルソナ・プロジェクト・グローバルの各設定に Kiro CLI のカスタムエージェント名（`kiro-cli chat --agent`）を渡せるようになった。`TAKT_PROVIDER_OPTIONS_KIRO_AGENT` 環境変数による上書きも可能。指定がないステップは Kiro CLI の既定エージェントを使う

### Changed

- `team_leader` のパート上限を `max_concurrency` と `max_total_parts` に分割 (#799)。`max_concurrency`（最大 3）は同時に走るワーカーパート数を、`max_total_parts`（最大 20）はリーダーがそのステップで計画できるパートの総数を制限する。従来の `max_parts` キーは `max_concurrency` の互換エイリアスとして引き続き受け付ける。あわせてチームリーダーの予算エラー検出を厳密化し、ワーカーパートが予算上限に達しても実行全体が中断しないようにした
- ビルトインのレビュー系・開発系ワークフローに純粋レビューパスを追加。汎用の `pure-reviewer` ペルソナ（`review-pure` インストラクションと `pure-review` 出力契約を伴う）が「この変更は今マージできるか」だけを判定し、未対応の要求・既存挙動の破壊・テスト不足・スコープ外の変更を検出する。peer-review・review・review-fix・backend(-cqrs)・frontend・dual(-cqrs)・terraform・maintenance の各ワークフローに組み込んだ。これにより従来の要件レビュアー（`requirements-reviewer` ペルソナと `requirements-review` 出力契約）は削除した
- ビルトインのレビュー・テスト系ファセットを強化。レビュアーとテスト作成ガイダンスが、置き換えられた仕様が消えたことだけを確認する「不在のみ」テストに対するガードレールを持つようになり、coding・review・testing ポリシー全体で挙動検証・レビュー検証・命名ポリシーのガイダンスを強化した

### Fixed

- レート制限の誤検出を低減 (#809)。レート制限検出のパターンが過度に広く、単独の `429`、通りすがりの `rate limit` という記述、通常のエージェント出力に含まれる `resets H:MM` のような時刻表記までレート制限と誤読してフォールバックを誘発していた。検出により具体的な表現（例: "too many requests" を伴う `429`、"rate limited" / "rate limit exceeded" / "rate limit error"、"exceeded/hit/reached rate limit"）を要求し、緩い単独時刻のストリームマーカーを廃止した
- OpenCode のパーミッション処理を修正 (#801, #803, #807)。OpenCode の `doom_loop` パーミッション要求が、有効なパーミッションモードによって拒否される代わりに自動応答されるようになり、非対話実行が停止しなくなった (#803)。パーミッション要求と解決済みパーミッションの要約をログ出力するようにした (#801, #807)。さらに OpenCode 連携を再構成し、編集系ツールが OpenCode の編集パーミッションに対応付くようにし、共有 OpenCode サーバープールを設定ごとにキー分けして適切な取得・解放・中断処理を行うようにした (#807)

## [0.45.0] - 2026-06-10

### Added

- フェーズ単位の usage イベントと usage 分析スクリプトを追加 (#785)。`observability.enabled: true` と `observability.usage_events_phase: true` を設定すると、実行ごとにフェーズ単位のトークン usage イベントを `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl` に出力する（既存の `logging.usage_events` 出力とは別ストリーム）。イベントはワークフローフェーズ（`phase1_execute`・`phase2_report`・ステータス判定の `phase3_structured` / `phase3_tag` / `phase3_fallback`）ごとに記録され、usage が取得できなかった呼び出しは 0 トークン扱いではなく `usage_missing: true` として記録される。新しい `npm run analyze:usage` スクリプトは、イベントファイルや実行ディレクトリを step × phase × provider × model 単位の Markdown / CSV テーブルに集計し、トークン合計と呼び出しごとの統計を出力する。新設の [Observability ガイド](./observability.ja.md) に記載
- インタラクティブモードでクリップボード画像ペーストに対応 (#791)。インタラクティブ入力中に Ctrl+V（または新しい `/paste-image` コマンド）で OS のクリップボードから画像を直接添付できるようになった。これまではターミナルがインライン画像（OSC 1337）エスケープシーケンスを送出する場合にのみペーストが機能していた。添付画像はプロバイダー抽象も通るようになり、`claude-sdk` と `codex` はネイティブの画像入力として受け取り、その他のプロバイダーにはプロンプト内に添付ファイルパスの参照が展開されるため、エージェントが自身のツールで画像を開ける

### Changed

- **BREAKING:** 中断された `running` タスクは自動再キューされなくなった (#791)。`takt run` や `takt watch` が中断（プロセスクラッシュ・強制終了）された場合、`running` 状態のまま残ったタスクは次回起動時に `pending` へ復旧されて再実行されていたが、今後は説明付きのエラーとともに `failed` にマークされる。再実行するには明示的に再キューする

### Fixed

- ワークツリー分離クローンが、fetch 済みの base branch コミットから分岐する際に missing object エラーで失敗しなくなった (#791)。`git reset --hard` の前に base branch のコミットをメインリポジトリから分離クローンへ fetch するようにし、reset 対象が常にクローン内に存在するようにした
- OpenCode の readonly パーミッションモードで読み取りツールが許可されるようになった (#797)。`readonly` モードは `read`・`glob`・`grep` を含むすべてのツールを拒否していたため、レビューなどの読み取り専用ステップがコードベースをまったく参照できなかった。これら 3 つの読み取りツールを許可し、編集・bash・ネットワーク系ツールは引き続き拒否する

### Internal

- Claude Agent SDK と Codex SDK の依存関係を更新 (#789, #795)
- リポジトリ自身の `.takt/config.yaml` から implement 系ステップの `takt-quality-check` コマンドゲートを削除

## [0.44.0] - 2026-06-03

### Added

- `kiro` プロバイダーを追加 (#773)。Claude・Codex・OpenCode・Cursor・Copilot に加えて、Kiro CLI を AI エージェントプロバイダーとして利用できるようになった。`--provider kiro` または設定で選択する。認証は設定の `kiro_api_key`（または環境変数 `TAKT_KIRO_API_KEY`）を使い、CLI バイナリは `kiro_cli_path` / `TAKT_KIRO_CLI_PATH` で上書きできる
- OpenTelemetry オブザーバビリティに動作するエクスポーターとスパンの拡充を追加 (#753)。0.42.0 で導入したスパン基盤の上に、実行ごとのワークフローメトリクスをローカルの `monitor.json` に出力する機能（`observability.monitor: true` で有効化）と、OTel スパンから派生するシャドウセッションログ（`observability.sessionLogExporter: true`）を追加し、スパンの対象をフェーズ実行とステータス判定（judge）フェーズにも拡張した。エクスポーターは実行 ID ごとにルーティングされ、シャドウセッションログは正規の NDJSON セッションログとレダクションの整合性を保つため、機微なエージェント出力はサニタイズされたままになる。引き続き `observability.enabled: true` の背後でデフォルト無効

### Changed

- コーディングレビューをすべてのビルトインのレビュー・開発ワークフローに拡張。これまで `default-peer-review` のみに含まれていた coding-review 並列サブステップ（`review-coding` インストラクションと `coding-review` 出力契約を持つ `coding-reviewer` ペルソナ）を、すべてのビルトインの review / review-fix ワークフローと、開発ワークフロー（backend・frontend・dual・terraform とその派生）の並列レビューワーウェーブに追加した。モデル自身のコーディング判断を用いて実装上のバグ・リグレッション・セキュリティリスク・テスト不足を指摘する、ほぼインストラクションを持たない汎用パスである。意図的に最小構成の `*-mini` と `compound-eye` の派生はそのままにしている

### Fixed

- Codex の `Reconnecting...` イベントで実行が中断されなくなった (#775)。Codex SDK の一時的な再接続が致命的なプロバイダーエラーとして表面化し、ワークフロー全体を停止させることがあったが、回復可能な再接続として扱い再試行するようになった
- ワークツリークローンの分離を強化 (#778)。`git clone --shared` の分離パスとクローン実行に対する修正（gitdir 分離処理の正規化を含む）により、ワークツリー分離タスクがメインリポジトリから正しく分離された状態を保つ

### Internal

- TAKT 自身の `.takt/config.yaml` にリポジトリの品質ゲートを組み込み、ドッグフーディングしているレビュー・開発ステップがコマンドゲート経由で build・lint・ユニット・モック E2E のチェックを実行するようにした

## [0.43.0] - 2026-05-29

### Added

- 画像添付に対応（実験的, #751）。画像を TAKT 全体で受け渡しできるようになった。対話モードではプロンプトに画像を直接ペーストでき（ターミナルのインライン画像 OSC 1337 シーケンスを保留中の添付としてデコードする）、`takt add` や再実行ではタスク仕様とともに画像添付が引き継がれ、エージェントはテキスト指示と一緒に画像を受け取る。assistant / passthrough / quiet / retry の各入力モードで動作し、1 画像あたり 10 MB の上限がある。動作確認中の実験的機能であり、挙動は変わる可能性がある
- ダイレクト run 向けの `takt resume` コマンドを追加 (#759)。失敗・中断したダイレクト（ワンショット・キュー外）run を `takt resume` で再開できるようになった。直近の失敗 / 中断したダイレクト run を探して、最初からやり直すのではなく続きから再開する。再開時は既存の run ディレクトリを再利用し、専用のスコアリングプロンプトがワークフローへの再入方法を判断する
- コマンド品質ゲートを追加 (#761)。ステップの `quality_gates` が、AI 指示の文字列に加えて、機械実行される `type: command` エントリを受け付けるようになった。コマンドゲートはエージェントステップ完了後に実行され、コマンドが終了コード `0` で終わった場合のみ通過する。失敗時は、コマンドのメタデータ・cwd・終了コード（またはタイムアウト / 出力上限の詳細）・出力ログのパス・上限付きでサニタイズした stdout/stderr を同じエージェントステップに差し戻して再試行させる。ワークフロー YAML のコマンドゲートを使うには設定で `workflow_command_gates.custom_scripts: true` が必要。`system` / `workflow_call` ステップは `quality_gates` を受け付けない
- ビルトインワークフロー `frontend-maintenance` を追加（実験的）。新規構築ではなく既存フロントエンドプロダクトの改修に向けたワークフローで、保守スコープの plan / implement / write-tests / fix / supervise インストラクション、`existing-system` ナレッジファセット、既存の規約を尊重させる `existing-system-respect` ポリシー、`maintenance-scope` 出力契約を同梱する。現状はやや過剰に動くことがあるため、既存プロダクト改修の出発点として使い、コードベースに合わせて調整することを推奨する実験的ワークフロー
- デフォルトのピアレビューに coding review を追加。ビルトインの `default-peer-review` ワークフローに、新しい `coding-reviewer` ペルソナ・`review-coding` インストラクション・`coding-review` 出力契約に基づく coding-review サブステップが加わり、既存の専門レビューワと並んで一般的なコード品質もレビューされるようになった

### Changed

- レビュー系ファセットを fix ↔ review ループでのスコープクリープに強くした（en + ja）。レビューの基準点をタスクのベースに固定し、各レビューワは直前イテレーションの増分ではなく merge-base からの累積差分全体を評価するようにした。これにより、過去のイテレーションで紛れ込んだ要求外の変更（無関係なコメント削除・リネーム・再フォーマット・テストの弱体化など）が、差分が直近の fix に狭まったときに見逃される問題を防ぐ。`ai-antipattern` のスコープクリープ検証を累積差分ベースに変更し、あわせて review と React のファセットガイダンスを精緻化した

### Fixed

- `claude-terminal` のプロンプト検出が Claude Code v2.1 で動作するようにした (#766, refs #765)。末尾行の正規表現がプロンプト行を厳密に `❯` / `❱` / `>` と一致させる必要があったが、v2.1 は `❯ Try "..."` のように描画するため `waitForClaudeInputReady` が一致せず 60 秒でタイムアウトしていた。プロンプト文字の後に空白または行末が続くものを受け付けるようパターンを緩和しつつ、busy 状態のゲートで誤検知を防いでいる
- Codex の `Reconnecting...` を致命的エラーとして扱わないようにした (#767)。Codex SDK の一時的な `Reconnecting... N/5` イベントが最終的な `provider_error` として表面化し、ワークフロー全体を abort させていたが、回復可能な再接続として扱い retry するようにした
- `team_leader` の part タイムアウトで run が abort しないようにした (#764)。worker part が `part_timeout` や feedback failure に達すると `TeamLeaderRunner` が即座に abort していたが、タイムアウト fallback で run を継続させ、さらに leader が巨大な単一 part を作りにくくなるよう分解インストラクションとファセットを調整した
- 並列レビューの集約が、1 つのレビューワのエラーでステップ全体を失敗させないようにした (#770)。並列 `reviewers` ステップで 1 レビューワの Phase 1 が `provider_error` になると、他のレビューワが完了していても集約が壊れていたが、`ParallelRunner` の terminal-status 処理を修正して正しく集約するようにした
- `review-fix-takt-default` がスーパーバイザの findings を正しくルーティングするようにした。review-fix スーパーバイザが挙げた findings が意図通りに fix ループへ戻されていなかったため、ワークフローのルールを修正した

### Internal

- 三段階ステップモデルのチュートリアルをドキュメントに追加 (#735)

## [0.42.0] - 2026-05-20

### Added

- `claude-terminal` プロバイダを追加 (#727)。Anthropic SDK（`claude-sdk`）や headless CLI（`claude`）を呼ぶのではなく、tmux ペイン内で対話型 Claude Code CLI セッションを起動し、セッションのトランスクリプトから結果を読み取る新しい実行方式。`--provider claude-terminal` または設定ファイルで選択する。structured output / MCP サーバ / allowed-tools に対応し、権限確認や ask-user-question のプロンプトはターミナル経由で受け渡しする。プロバイダオプションは `provider_options.claude_terminal` 配下（`backend: tmux`, `timeout_ms`, `keep_session`, `transcript_poll_interval_ms`）。利用には `tmux` のインストールが必要で、`maxTurns` は非対応、トランスクリプトに含まれないため API 使用量は取得できない
- オプトインの OpenTelemetry オブザーバビリティを追加 (#706, #745)。`~/.takt/config.yaml`（グローバル）または `.takt/config.yaml`（プロジェクト）で `observability.enabled: true` を設定する（環境変数 `TAKT_observability__enabled` でも上書き可）と、ワークフロー実行の OTel スパンを出力する。各 run は `workflow.<name>` スパンを生成し、その子として `step.<name>` スパンが付き、ワークフロー / ステップ名・ステップ種別・iteration 回数・解決された provider / model（とその設定ソース）・最終ステータス（abort 種別を含む）といった属性を持つ。スパンは通常実行と並走する非ブロッキングの「シャドウ」として出力され、run の挙動は一切変えない。基盤は OTel Node SDK（サービス名 `takt`）を初期化するが exporter は同梱しないため、標準の `OTEL_*` 環境変数で自前のコレクタに接続する。デフォルトは無効
- `/accept` 対話コマンドを追加 (#733)。対話アシスタントモードで、`/accept` は直近のアシスタント発言をそのままタスクとして実行する（`/go` による要約を経由しない）。アシスタント発言がまだ無い場合は、先にタスク内容を入力するよう促す
- アシスタント init ファイルを追加 (#734)。`.takt/config.yaml` の `assistant.init_files` にプロジェクトのコンテキストファイルを列挙すると、対話アシスタントの会話ごとに「Assistant Init Context」セクションとして自動的に読み込まれる。これによりアーキテクチャメモ・規約・独自指示などのプロジェクト固有コンテキストを毎回手作業で渡さずに済む。パスはプロジェクト内の相対パスに限られ、機微なファイル（`.env*`, `.pem`, `.key`, `.npmrc`, `.netrc`, `.git/` など）は拒否される。上限は 16 ファイル / 1 ファイル 256 KB / 合計 1 MB
- GitHub PR のレビュースレッドを解決状態で分類するようにした (#746)。PR レビューコメントをタスクに取り込む際、スレッドを Active・Outdated だが未解決・解決済み / Outdated の各セクションに分け、それぞれ誰が解決したか・outdated かどうかを注記する。レビューポリシーにより、エージェントは active スレッドに集中し、outdated だが未解決のものは現在も該当するか再確認し、解決済みスレッドは同じ問題がコードに残っていない限りスキップする。これにより対応済みのフィードバックを蒸し返さない
- enqueue effect の `base_branch` でブランチを必要時に作成できるようにした (#725)。システムワークフローの enqueue effect の `base_branch` が、従来の文字列に加えてオブジェクト形式 `{ name, create_if_missing: { from, push } }` を受け付けるようになった。指定したベースブランチが存在しない場合、TAKT が `from` から作成する（`push: true` のときは push も行う）。ビルトインの `auto-improvement-loop` はこれを使って `improve` ベースブランチを `main` から自動作成するため、手動のブランチ準備なしでループを実行できる

### Changed

- ビルトインのレビュー系ファセットを補強（en + ja）。`cqrs-es` ナレッジにイベント進化と抽象境界に関するガイダンスを追加し、ai-antipattern / coding / qa / review / testing ポリシーの REJECT / APPROVE 基準を強化、frontend ナレッジと frontend-review 出力契約に canonical state（正規の状態）に関するガイダンスを追加した。ワークフロー構造は変えずに、ビルトインレビューワが何を強制するかを精緻化している

### Fixed

- OpenCode の応答で、SDK が差分（delta）と全文スナップショットの両方を出すときにコンテンツが二重化する問題を修正 (#749)。従来は両ストリームを連結していたため、アシスタントのテキストが応答に二重に現れていた
- プロバイダの rate-limit メッセージを、汎用的なプロセスエラーに潰さずに保持するようにした (#730)。プロバイダが rate limit を報告した際、元のメッセージが応答を通じて残るため原因が見えるようになる

### Internal

- 設定ドキュメントとバリデーションエラーメッセージの表記を snake_case に統一 (#747)。設定リファレンスとエラー文が camelCase 名（`workflowArpeggio`, `syncConflictResolver`, `taktProviders` ……）を使っていたが、これらはパーサが実際に期待する snake_case の YAML キー（`workflow_arpeggio`, `sync_conflict_resolver`, `takt_providers` ……）とは一致していなかった。ドキュメントとメッセージが TAKT が実際に読み取るキーを示すようになった。挙動・スキーマの変更はない
- リポジトリレビュー向けに CodeRabbit 連携を追加。`.coderabbit.yaml` 設定、TAKT ファセットを `code_guidelines` として参照、probe 結果に基づく設定チューニング、スポンサー記載 (#737, #738, #742, #744)
- CI を統合し、トリガーを `/review` に変更。`issue_comment` 駆動の 4 ワークフローを単一の `pr-comment-commands.yml` に統合し、takt-review のコメントトリガーを `/takt-review` から `/review` に変更した (#726, #728, #736)
- ドキュメントを再編成。Design Philosophy ページと External Integrations ページを追加し、workflows ガイド（`workflows.ja.md` を含む）を最新化、古い内部ドキュメント（data-flow / provider-sandbox / report-phase-permissions / agents）を削除した (#723, #729, #739)
- 実行されない成果物に対する脆いテスト（README 用語 / instruction テンプレートのチェック）を削除し、testing ポリシーにそうしたテストを避ける指針を追加 (#730)

## [0.41.0] - 2026-05-14

### Added

- ステップレベルの `promotion` フィールドを追加 (#349)。同一ステップの実行回数や AI 判定に応じて `provider` / `model` / `provider_options` を昇格させる仕組み。各エントリは `at: <実行回数>`（その回以降にマッチ）と `condition: ai("...")` を任意で指定でき、昇格先として `provider` / `model` / `provider_options.*` のいずれかを 1 つ以上指定する。複数エントリは宣言順に評価し、最後にマッチしたものを採用。例として「2 回目までは速い軽量モデル、3 回目以降は Opus に昇格」「レビューが連続 reject されたら Claude Opus に昇格」といった用途を想定している。promotion はモデル / プロバイダ解決の最優先ソース（CLAUDE.md の解決順位を参照）。並列サブステップでは未サポート
- Rate-limit fallback chain を追加 (#716)。`rate_limit_fallback.switch_chain` 設定（workflow `workflow_config` / プロジェクト `.takt/config.yaml` / グローバル `~/.takt/config.yaml`）により、Claude / Codex / OpenCode の rate-limit ヒット時にワークフローを中断させず、チェーン上の次プロバイダで同じステップを再実行できる。新セッションには fallback notice instruction (`facets/instructions/_system/fallback-notice.md`) が挿入され、中断理由・再実行対象ステップ・`report_dir` や commit diff からコンテキストを再構築する手順が伝わる。チェーン内の試行履歴は workflow state に追跡され、ステップ成功でリセットされる
- `auto-improvement-loop` で AI が GitHub Issue タイトルを生成するようにした (#333)。followup-task / pr-followup-task の structured output スキーマを `title`, `type`, `scope`, `summary`, `goals`, `acceptance_criteria`, `labels` に拡張。プランニング instruction は AI に対し、Issue に適した短いタイトル（`# タスク指示書` / `# Task Order` のような汎用見出しは禁止）と構造化メタデータの出力を要求する。TAKT 側は `summary` / `goals` / `acceptance_criteria` を `## 概要 / ## 目的 / ## 受け入れ条件` の Markdown テンプレートに埋め込んで Issue 本文を生成する。タイトルが空 / 短すぎ / 禁止パターンに該当する場合は `fallback_reason` メトリクス付きで安全にフォールバックする
- OpenCode `provider_options.opencode.variant` を追加 (#694)。OpenCode の `prompt` 呼び出しに渡す model variant（`high` / `low` 等）を文字列としてパススルー。step `provider_options`、workflow / persona / project / global 設定、`TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT` 環境変数のいずれからも指定可能
- `PromptBasedStructuredCaller` の JSON パース失敗時リトライを追加 (#695)。`decomposeTask` / `requestMoreParts` を `withRetry`（最大 3 回、1000 ms 間隔）でラップし、\`\`\`json ... \`\`\` 抽出失敗・スキーマバリデーション失敗・provider の `status: 'error'` 応答などの一時的失敗で team-leader 全体が abort しないようにした。各リトライは `log.info` で `attempt` / `maxAttempts` / `error` を構造化ログ出力し、頻度を観測可能にしている。最終リトライも失敗した場合は元のエラーをそのまま伝播する。リトライによる `phase:start` 重複発火は dedup ガードで抑止し、`phase:start` / `phase:complete` の対称性を維持する

### Changed

- レビュー系インストラクションの観点列挙を廃止し、レビューワが policy / knowledge を直接読み込むように統一 (#718)。`review-arch` / `review-cqrs-es` / `review-frontend` / `review-qa` / `review-requirements` / `review-security` / `review-terraform` / `review-test` / `ai-antipattern-review` の 9 ファイルおよび `supervise` / `implement` / `implement-after-tests` から固有の「レビュー観点」リストを削除。代わりに「Knowledge / Policy の Source Path を Read で開く → `##` セクションを全列挙 → 各セクションの判定基準を差分と照合する」の 3 ステップ手順に統一した。複数レビューに転記されていた共通手順（設計判断の参照 / 前回指摘の追跡 / 判定の最終手順）は `policies/review.md` の「レビューの基本手順」に集約。これにより、policy / knowledge に章を追加しても instruction に追記しないと反映されない drift（PR #713 で ai-antipattern policy のデッドコード章が観点に未登録だった事例）を解消。`INSTRUCTION_STYLE_GUIDE.md` にも「レビュー系インストラクションでの観点列挙の禁止」を明文化した
- Phase 1 プロンプトテンプレに「判断ルール」セクションを追加（en + ja）。全ステップ共通の指示として「未確認の値を推測しない」「同一セッションの過去 iteration の『修正済み / 確認済み』記憶を信用せず、判断直前に現在のファイル / ワーキングツリーで再確認する」の 2 ルールを注入する。長時間セッションでの context rot 対策
- `cqrs-es` ナレッジに Aggregate の判断境界を明示。イベント再生で再現できる状態（Aggregate の責務）と、外部識別子の形式解釈や所有権確認（API 層 / UseCase 層の責務）を判定テーブルで切り分け、外部識別子の解釈を Aggregate に持ち込まない原則を追加した
- Frontend / React 系ナレッジを補強（knowledge `frontend.md` / `react.md`、en + ja）。既存章に対するレビュー判定基準のピンポイント追記

### Fixed

- `claude-sdk` プロバイダが overage 未提供の組織で毎ステップ rate-limit 扱いになる問題を修正。`rate_limit_event` は呼び出しごとに情報イベントとして必ず流れ、overage 非対応組織では `overageStatus = 'rejected'` が恒常状態となる。これまでの OR 判定では単独の `rejected` overage を rate-limit ヒットと誤検出し、ステップが即時 abort していた。`isRejectedRateLimitEvent` はベース `status === 'rejected'` かつ overage が救済しない場合のみ true を返すよう訂正し、誤った仕様を固定していたテストも併せて修正した

### Internal

- `delay()` ヘルパーを `shared/utils/delay.ts` に集約し、`ArpeggioRunner` と `PromptBasedStructuredCaller` で共用するようにリファクタリング。`src/__tests__/delay.test.ts` にユニットテストを追加

## [0.40.0] - 2026-05-10

### Added

- `takt list` の failed タスクに `Requeue` アクションを追加 (#435)。これまで failed タスクの選択肢は会話モード必須の `Retry` と `Delete` のみで、別タスクに集中している間にサクッと再実行キューへ戻す手段がなかった。`Requeue` は会話を経由せず直接 pending に戻すため、原因分析が不要なケースを最短で再投入できる。`retry_note` は失敗 step 名 / エラー要約 / 「ユーザーが対処済みと判断したため再投入」というコンテキストから自動生成し、再実行時のエージェントが `## 再投入メモ` で読み取れる。既存の `retry_note` は上書きせず累積追記する
- AI アンチパターンレビューを reviewers サイクル毎に実行するように追加。`default` / `default-mini` / `default-high` / `backend` / `backend-cqrs` / `dual` / `dual-cqrs` / `frontend` / `terraform` / `takt-default` の reviewers parallel ステップに `ai-antipattern-review-2nd` を追加し、`fix` 後に混入した過剰防御や幽霊コメントを毎サイクルで検出するようになった。split 構成（`backend` / `dual` / `frontend` 系）では `reviewers_1` のみに配置している（`fix` は常に `reviewers_1` に戻るため）

### Changed

- **BREAKING:** AI アンチパターン系ファセットの命名を `ai-antipattern-*` に統一し、1st / 2nd で分離。`ai_review` (standalone) -> `ai-antipattern-review-1st`、`ai_review` (parallel sub-step) -> `ai-antipattern-review-2nd`、`ai_fix` / `ai_no_fix` -> `ai-antipattern-fix` / `ai-antipattern-no-fix`、`ai_fix_parallel` -> `ai-antipattern-fix-parallel` にリネーム。`review-ai.md` は `ai-antipattern-review.md` に統合して削除。`loop-monitor-ai-fix.md` も `loop-monitor-ai-antipattern-fix.md` にリネーム。これらの step 名 / instruction / report format を参照しているカスタムワークフローは追従更新が必要
- レビューポリシーで CHANGELOG / RELEASE_NOTES / MIGRATION を「過去時点の記録」として扱うよう変更 (#710)。リネームや仕様変更後に過去エントリの設定キー・API 名が現行コードと一致しないことだけを根拠にレビュアーが REJECT する挙動を抑制した。新規追加エントリの対象リリース時点での事実誤認や Markdown 崩れ・重複・リンク切れは引き続き REJECT 可。判別はファイル名（`CHANGELOG.md` 等）または慣用的見出し（`### Changed` / `### Added` / リリース日付つき見出し）で行う
- `default` / `default-mini` / `default-high` / `takt-default` ワークフローを subworkflow ベースに再編。default 系は `default-draft` / `default-peer-review`、takt-default 系は `draft` / `peer-review` を共有する。親ワークフローは `workflow_call` で構成され、subworkflow は `params`（`impl_knowledge` / `fix_knowledge` / `arch_knowledge` 等）で各親の knowledge facet を差し替えられる。subworkflow は `visibility: internal` でワークフロー選択 UI から見えない。ユーザーから見た挙動は同一
- quiet / passthrough モードに専用イントロ表示を導入 (#593)。これまで両モードでも `/go` / `/cancel` 等の slash command を案内するアシスタントモード共通のイントロが表示されていたが、これらのモードでは実際にはそれらのコマンドが解釈されず誤誘導になっていた。quiet モードは `interactive.ui.introQuiet`、passthrough モードは `interactive.ui.introPassthrough` を表示するように変更し、英日両方の i18n ラベルを追加した
- `auto-improvement-loop` の structured output schema を Codex 互換に強化。`followup-task` で `task_markdown` / `issue` を required に、`pr-followup-task` で `task_markdown` を required に変更。各 action でこれらのフィールドをどう埋めるか（`wait_before_next_scan` / `prepare_merge` / `reject_pr` では空文字列、`enqueue_new_task` 等では実体を埋める）を planning instruction で明示するようにした。Codex provider が部分的な `agent_message` を返した場合に schema 側で弾けるようになった

### Fixed

- Codex provider の structured output 抽出を、連結済み stream content ではなく最後の `agent_message` text ベースに変更 (#707)。Codex セッションが `agent_message` を複数回出すケース（途中 JSON 草案の後に最終応答が来るパターン）で、従来実装は全 text を連結して 1 個の JSON object として parse しようとし、JSONL のような形になって `Structured output response is missing` で abort していた。`outputSchema` 指定時は最後の `agent_message.text` を独立して parse するよう変更し、途中の古い JSON を誤採用せず `auto-improvement-loop` が abort しなくなった

### Internal

- CI: `takt-review` ワークフローに `concurrency.cancel-in-progress: true` を追加し、同一 PR への新規 commit 時に古いレビュー実行をキャンセルするようにした。古いリビジョンに対する無駄なレビュアー実行が走らなくなる

## [0.39.0] - 2026-05-02

### Added

- ファセット継承構文 `{extends:<parent>}` を追加 (#690)。ファイル由来のファセットが同じ種類の親ファセットを継承できるようになった。親はファセット種別とレイヤ順で解決し、自己参照除外と循環検知はソースパスベースで行う。instructions / policies / knowledge / output contracts / loop monitor の judge instructions に適用される。親名は bare なファセット名のみ（path 参照や `@scope` 参照は不可）、persona ファセットは継承非対応
- step レベルの `allow_git_commit` フィールドを追加 (#587)。Phase 1 / Phase 2 のインストラクションに注入される「git add / commit / push を実行しない」制約を、step 単位でオプトイン解除できる（デフォルト `false`）。1 つのタスクで多数の issue を消化するワークフローなど、作業単位ごとに git commit したいユースケースに使う
- ビルトイン workflow `default-mini` を追加。`default` から `write_tests` を抜いたミニ版（`plan -> implement -> AI antipattern review -> parallel review -> complete`）。Quick Start カテゴリと Mini カテゴリ、builtin カタログに登録
- run チェックポイント再開を追加 (#568)。run 実行中の `currentStep` / `phase` / `iterations` / `resumePoint` を `.takt/runs/<slug>/meta.json` に継続的に保存するようになり、`tasks.yaml` が `start_step`（`start_movement` は後方互換のエイリアスとして保持）を受け付けることで中断 run の再開時に最後に動いていた step から続行できる
- エージェント失敗のカテゴリ分類を追加 (#678)。team leader part の失敗を `external_abort` / `part_timeout` / `provider_error` / `stream_idle_timeout` に分類し、trace report / session log / 集約エラーメッセージに分類を残すようになった。これまで「execution aborted」に潰れていた原因が判別可能になる。Codex クライアントは abort cause（`timeout` / `external`）を保持し、failure detail に伝搬する

### Changed

- `mode: system` ワークフローを project workflows root の外でも実行できるように緩和 (#691)。`mode: system` / workflow-level `runtime.prepare` / step `allow_git_commit: true` は従来 `.takt/workflows/` 配下でないと拒否されていたが、ビルトイン workflow（`auto-improvement-loop` 等）と `~/.takt/workflows/` 配下の global workflow を許可するようになった。再利用可能な orchestration workflow を global に置いて名前指定で実行できる。path-based に workflow を再分類していた旧 trust boundary は撤去され、loader 確定済みの `WorkflowTrustInfo` を後段でも使うようにした
- `auto-improvement-loop` の PR 分岐 action セットを整理 (#676)。`comment_on_pr` と `noop` を削除し、`reject_pr` を追加。PR 分岐の選択肢は `enqueue_from_pr` / `prepare_merge` / `reject_pr` の 3 種に固定。`reject_pr` は `close_pr` effect で PR を close するのみで、コメント追加・ブランチ削除・タスク再エンキューは行わない。`pr-followup-task` schema の enum も同期して更新
- `auto-improvement-loop` の Issue 分岐 / fresh planning を強化 (#685)。`plan_from_issue` / `plan_fresh_improvement` から `noop` を削除し、planning instruction で低価値・cosmetic-only・曖昧・既存 PR / Issue と重複するタスクを明示的に拒否、具体的な成果物・完了条件を必須化。`followup-task` schema の action enum は `enqueue_new_task` / `wait_before_next_scan` の 2 種に縮小
- レートリミット原因を workflow abort 経由でも保持 (#569)。Claude のレートリミットが provider events で観測された場合、後段の phase / parallel / workflow エラー表示が generic な `Claude Code process exited with code 1` ではなく `Rate limit exceeded. Please try again later.` として残るようになった。`AgentResponse.errorKind` を provider 境界で正規化することで、session resume / report phase retry 経路でも原因が潰れない

### Fixed

- OpenCode 共有サーバーが takt 終了後に残り続ける問題を修正 (#550)。OpenCode provider を使った takt の終了後、opencode サーバープロセスがバックグラウンドで残ってリソースを消費し続ける状態だった。takt 終了時に共有サーバーを deterministic にクリーンアップするようになった
- 対話モードの `/go` が事前会話履歴なしでも動作するように修正 (#680)。会話履歴が空の状態で `/go` を実行すると失敗していたが、初回入力をそのままワークフロー実行に渡せるようになった。既存の対話ありフローは維持
- `takt watch` 停止後の stdin ハンドラ未解放を修正。即時 SIGINT exit インストーラーが cleanup フックを返すように変更し、`parseAsync` / slash fallback いずれの経路でも cleanup を呼ぶようにしたため、watch が組み込んだ stdin ハンドラが解放されてプロセス終了がブロックされなくなった
- 対話モードに AI 応答中の進捗表示を追加。ユーザー入力送信後は `Assistant is thinking...`、`/go` での会話要約中は `Creating instruction...` を表示するようになり、takt が固まっているように見える状態を解消した。AI 呼び出し中は stdin を pause する。多段入力エディタの送信キーが CR (`\r`) に加えて LF (`\n`) でも反応するようになり、貼り付けや `\n` 終端の入力もそのまま送信される。改行を入力したい場合は `Shift+Enter`（CSI `13;2u`）を使う

## [0.38.0] - 2026-04-25

### Added

- `persona_providers.<persona>.provider_options` をサポート (#623)。persona ごとに `provider` / `model` と並んで `provider_options`（`claude.effort`、`codex.reasoning_effort` 等）を設定可能になり、各 step に同じ provider option を重複記述する必要がなくなった。優先順位: step > workflow > persona > project > global > default
- インストラクションテンプレート変数に report handle (`{current_report}` / `{previous_report}` / `{report_history}` / `{peer_reports}`) を追加 (#627)。reviewer / fix / supervise 系 step で、自ステップ最新／直前レポートや peer ステップ最新レポート群を、ファセットに具体的なファイル名を直書きせず抽象的に参照できる
- レビュー系 output contract に検証証跡セクションを標準化 (#628)。`architecture-review`、`qa-review`、`testing-review`、`security-review`、`requirements-review` でビルド / テスト / 動作確認の確認対象・確認内容・結果（または「未確認」の明示）を共通フォーマットで記録するようになり、Supervisor 側で証跡判定が安定する
- `default-high` workflow を追加。team-leader 実装＋5並列レビュー＋仲裁付き AI アンチパターンレビュー＋監督を組み合わせたフルスペック汎用 workflow（`plan -> write_tests -> team-leader implement -> AI review -> 5並列 review -> fix -> supervise -> complete`）。Quick Start カテゴリも `default` / `default-high` / `frontend` / `backend` / `dual` に再構成
- `takt-default-refresh-all` / `takt-default-refresh-fast` workflow を追加。TAKT 開発 workflow の `session: refresh` 比較版で、`refresh-all` は全 step を refresh、`refresh-fast` は文脈肥大しやすい step（`write_tests`、`ai_review`、各 reviewer、`fix`）にのみ refresh を入れる
- `takt watch --ignore-exceed` オプションを追加 (#651)。`takt run --ignore-exceed` と同じ意味で、workflow の `max_steps` 超過を無視して継続実行し `exceeded` 扱いにしない
- `provider_options.*.effort` の値と解決ソースを console / NDJSON に表示 (#647)。active な provider の effort（`claude.effort` / `codex.reasoningEffort` / `copilot.effort`）が console の `Provider:` / `Model:` と並んで表示され、debug / verbose 時には `(source: step|persona|global|...)` も表示される。NDJSON `step_start` には全追跡パスの `providerOptions` / `providerOptionsSources` が常時記録される
- Issue を紐づけずに作成された task ベース PR の `## Summary` で `order.md` 全文を本文として使うように変更 (#600)。従来は空セクションだったが、PR 上で「何をやる task だったのか」を直接読めるようになった

### Changed

- `<!-- takt:managed -->` hidden marker をデフォルト付与から opt-in に変更 (#665)。通常の `--auto-pr` / `autoPr` で作成される PR には marker が付かなくなり、`auto-improvement-loop` などの orchestration 由来 task のみが marker を付与する。通常の pipeline / task 実行で作られる PR は人手作成 PR と区別がつかなくなる
- workflow の `source` / `trust` 解決を loader 入口で一本化 (#660)。parser / normalizer / doctor / `workflow_call` の子ロード経路がいずれも loader が確定した `WorkflowTrustInfo` を使うようになり、後段の path-based fallback で再分類されなくなった。`auto-improvement-loop` のようなビルトインの privileged workflow が discovery / runtime / doctor で一貫して builtin として扱われる
- インタラクティブモードで `--pr` のソースコンテキストを会話履歴から分離 (#656)。`--pr` で取得した PR レビューコメントは hidden な User 発話として `history` に積まず、独立した「Source Context」枠で保持する。`/go` 要約時に PR コメント全文をユーザー要求として誤解して指示書が肥大することを防ぐ
- `takt-default` の `implement` step（team leader / part worker）に親 `takt run` の PID を protected PID として注入し、短い process-safety policy を適用 (#603)。AI が cleanup 判断時に `pkill` / `killall` / 名前ベース kill で親 run を巻き込む事故を防ぐ
- Retry / re-execution の開始前に、既存 worktree の project-local `.takt/` を root の最新状態で同期するように変更 (#607)。root 側の facet / workflow / output-contract 修正が retry でも反映されるようになり、初回実行と retry の挙動が揃う
- PR 同期系 system effect（`sync_with_root`、`resolve_conflicts_with_ai`）を PR スコープ実行に整理 (#661)。専用の一時 worktree / checkout で PR branch を直接対象化するため orchestration step の `cwd` に依存せず、`auto-improvement-loop` の `prepare_merge` が orchestration の実行場所に関わらず deterministic に成功する

### Fixed

- `team_leader + output_contracts.report` の step で、root session 不在を理由に report phase が abort する問題を修正 (#655)。`runReportPhase()` が team leader の集約 `lastResponse` を fallback として受け付けるようになり、root session も `lastResponse` も無い場合のみ失敗する
- takt 自身のリポジトリで discovery 経由のロード時、ビルトイン workflow の `source` / `trust` 情報が path-based に project workflow へ再分類されてしまう問題を修正 (#659)。`auto-improvement-loop` を含む privileged ビルトイン workflow が discovery 経路でも builtin として正しく扱われる（恒久対応は #660）
- `provider_options.copilot.effort` の設定保存ラウンドトリップが落ちていた問題を修正 (#626)。`denormalizeProviderOptions()` が `copilot.effort` を raw 形式へ書き戻すようになり、設定保存経路で値が消えなくなる
- managed PR の判定で `takt-managed` GitHub label への依存を撤去。hidden marker `<!-- takt:managed -->` を managed PR の唯一の識別子に統一

### Internal

- SDK 依存を更新: `@anthropic-ai/claude-agent-sdk` ^0.2.71 -> ^0.2.119、`@openai/codex-sdk` ^0.114.0 -> ^0.125.0（バンドル `@openai/codex` バイナリも 0.114.0 -> 0.125.0）、`@opencode-ai/sdk` >=1.2.10 <1.3.0 -> ^1.14.24（v2 export は維持）
- `claude` provider で `provider_options.allowed_tools` が `claude --allowed-tools` に伝搬し、`Bash(python3 -m pytest:*)` が approval なしで通ることを実 claude provider で検証する E2E テストを追加
- レビュー系 workflow で行数閾値をテスト失敗扱いしないようガイダンスを更新

### Experimental

以下の機能は調整中です。挙動・スキーマ・命名は今後のリリースで変更される可能性があります。破壊的変更を許容できる場合のみ利用してください。

- `auto-improvement-loop` ビルトイン workflow (#653)。リポジトリを定期スキャンし、優先度（PR -> Issue -> fresh improvement -> wait -> route）でタスクを振り分ける無限ループのオーケストレーション workflow
- `max_steps: infinite`（step 上限なし、`exceeded` にならない）。現状は `auto-improvement-loop` で利用
- `pr_list` system input（`author` / `base_branch` / `head_branch` / `draft` で絞り込み可能な open PR 一覧）
- `issue_list` / `issue_selection` system input (#662)。orchestration workflow からリポジトリ全体の open Issue を観測できる
- `task_queue_context.items`（キュー内容を `when:` から参照可能）
- `when:` の配列参照と `exists(list, item.field == "X")` 関数。初期スコープは `==` と `&&` のみ
- `followup-task` ビルトイン構造化出力 schema（`enqueue_new_task` / `comment_on_pr` / `enqueue_from_pr` / `prepare_merge` / `noop` の action）

## [0.37.0] - 2026-04-20

### Added

- callable subworkflow に `params` / `returns` / `visibility: internal` を追加 (#635)。親 `workflow_call.args` から子 workflow に引数を渡し、子は `return` で論理結果を親に返せるようになった。param の対応型は `facet_ref` / `facet_ref[]`、`facet_kind` は `knowledge` / `policy` / `instruction` / `report_format`。子 workflow 内では `$param:` で facet field を差し替え可能。`visibility: internal` で内部用 subworkflow をワークフロー選択 UI から隠せる
- provider / model の解決ソースを log に表示 (#370)。`cli` / `persona_providers` / `step` / `project` / `global` / `default` のどの層で確定したかを debug または verbose 時にコンソール表示し、NDJSON `step_start` イベントの `providerSource` / `modelSource` フィールドには常時記録。期待と異なる provider / model が選ばれたときの原因特定が容易になる
- `provider_options.claude.effort` に `xhigh` を追加。Opus 4.7 のみサポートされる reasoning level（`high` と `max` の中間）。Claude Agent SDK を 0.2.114 へバンプ。モデル能力テーブルで早期検証し、`claude-opus-4-6` + `xhigh` のような非互換組み合わせは具体的なエラーメッセージで弾く。alias (`opus` / `sonnet` / `haiku`) と未知モデルは permissive に SDK 側へ委ねる
- `takt run` に `--ignore-exceed` オプションを追加 (#629)。指定時は workflow の `max_steps` 超過を無視して最後まで実行継続する。未指定時は従来通り `exceeded` 扱いで requeue される

### Changed

- **BREAKING:** 旧用語 `piece` / `movement` のレガシー環境変数サポートを完全に削除 (#637)。`TAKT_PIECE_*` / `TAKT_MOVEMENT_*` 形式の環境変数はマッピングされなくなる。`TAKT_WORKFLOW_*` / `TAKT_STEP_*` など新名称の環境変数への移行が必須

### Fixed

- Codex プロバイダーでタイムアウト（`abortCause === 'timeout'`）発生時に workflow が停止していた問題を修正 (#640)。タイムアウトをリトライ対象に追加し、最大 2 回までリトライする。外部からの明示的な中止（`abortCause === 'external'`）はリトライ不可のまま維持

## [0.36.0] - 2026-04-15

### Added

- サブワークフロー呼び出し（`call:` ステップ）を追加: ステップに `call: <workflow-name>` を指定すると、別のワークフローをサブルーチンとして実行可能。呼び出し先ワークフローは `subworkflow: { callable: true }` 宣言が必要。`overrides:` でプロバイダ/モデルの上書きも可能。再帰呼び出し検知・最大ネスト深度 5 (#153, #624)
- システムステップ（`kind: system`）を追加: AI エージェントを介さずに実行されるステップ。`system_inputs:` でランタイムコンテキスト（タスク、ブランチ、PR、Issue、タスクキュー）をワークフロー状態にバインドし、`effects:` で副作用（`enqueue_task`, `comment_pr`, `sync_with_root`, `resolve_conflicts_with_ai`, `merge_pr`）を実行 (#586, #622)
- 決定論的 `when:` ルール条件を追加: ルールに `condition:` の代わりに `when:` を指定すると、比較演算子（`==`, `!=`, `>`, `<`, `>=`, `<=`）やブール論理（`&&`, `||`）、ワークフロー状態参照（`context.*`, `structured.*`, `effect.*`）で AI を介さずルーティング (#586, #622)
- ステップの構造化出力（`structured_output:`）を追加: `structured_output: { schema_ref: "<name>" }` でワークフロー定義の `schemas:` マップ内の JSON スキーマを参照し、エージェント出力をバリデーション・保存。他ステップから `{structured:step.field}` で参照可能 (#586, #622)
- インタラクティブモードにスラッシュコマンド補完メニューを追加: `/` 入力時にインライン補完ドロップダウンを表示。矢印キーで選択、Tab で適用、Enter で確定。コンテキストに応じて `/retry` `/replay` の表示を制御 (#580)
- Copilot プロバイダに `effort`（推論の深さ）設定を追加: `provider_options.copilot.effort` で `low` / `medium` / `high` / `xhigh` を指定可能 (#625)
- `takt workflow init <name>` コマンドを追加: ワークフローのスキャフォールドを生成。`--template minimal|faceted`、`--steps <count>`、`--description <text>`、`--global` オプション対応 (#597)
- `takt workflow doctor [targets]` コマンドを追加: ワークフロー YAML の定義を検証。ターゲット未指定時は `.takt/workflows/` 内の全ワークフローを検証。ワークフロー名またはファイルパスを指定可能 (#597)
- 画面専用 API ポリシー（`screen-api`）を追加: 画面単位の専用エンドポイント、サーバー主導のページネーション、サーバーサイド集約、スコープ付きタブ通信を強制。全 dual 系ワークフローに適用
- AI アンチパターンポリシーに早期キャッシュ戦略の禁止ルールを追加: 明示的な要求や計測なしにキャッシュレイヤー・localStorage キャッシュ・過度な memoization を導入することを REJECT

### Changed

- **BREAKING:** 旧用語 `piece` / `movement` を完全に廃止し、`workflow` / `step` に統一 (#602, #609)。ワークフロー YAML の `piece_config:` → `workflow_config:`、`movements:` → `steps:`、`initial_movement:` → `initial_step:`、`max_movements:` → `max_steps:` への移行が必須。ディレクトリも `~/.takt/pieces/` → `~/.takt/workflows/`、`.takt/pieces/` → `.takt/workflows/` に変更。レガシー環境変数（`TAKT_PIECE_*`）は引き続きマッピングされる
- 非対応プロバイダ向けの provider-specific オプション（`claude.allowed_tools`、`mcp_servers`、`team_leader.part_allowed_tools`）をサイレントドロップするよう変更。ワークフローをプロバイダ非依存に保てるように改善
- 全レビュー系インストラクションのエビデンスガイダンスを統一: `reopened` ステータスの追加、検証ターゲット・確認内容・観測結果の記録を必須化、オープン指摘事項の脱落防止ルールを追加

### Fixed

- 全 audit 系ワークフロー（7 種）で supervise ↔ review 間のデッドロックを修正。review ステップに `output_contracts` を追加し、ループモニターの閾値を 4→3 に調整、ジャッジの選択肢を 3 択（十分/進捗あり/停滞）に変更

### Internal

- `piece*` → `workflow*` のファイル名一括リネーム（84 ファイル、テスト・E2E フィクスチャ・ドキュメント含む）
- `WorkflowEngine` をリファクタリング: `WorkflowEngineSetup`、`WorkflowEngineStepCoordinator`、`WorkflowRunLoop` に責務を分離
- セッションロガーを `sessionLoggerPhaseTracker.ts`、`sessionLoggerRecordFactory.ts` に分割
- `CapabilityAwareStructuredCaller` を追加し、プロバイダの構造化出力対応可否に応じたルーティングを実装
- ルール評価を 10 段階フォールバックに拡張（`when:` 条件の評価ステージを追加）
- `workflow-state-access.ts` でテンプレート参照（`{context:*}`、`{structured:*}`、`{effect:*}`）の統一解決を実装

## [0.35.4] - 2026-04-11

### Changed

- レビューポリシーにツール出力の信頼性検証ルールを追加: ツール出力が正常に読めることを確認してから指摘すること、検索失敗だけでコード不在と断定しないことをルール化

### Fixed

- ターミナルの行数が少ない環境で選択メニューが正常に動作しない問題を修正。ビューポートベースのスクロールを追加 (#608)
- Windows で `.cmd` shim の spawn が失敗する問題を修正（Claude Headless、Cursor、Copilot プロバイダ）

### Internal

- 選択メニューを `select-menu.ts`、`select-viewport.ts` に分離し、純粋関数化とビューポートテストを追加
- ワークフロードキュメントの例で古いフィールド名を使っていた問題を修正 (#619)

## [0.35.3] - 2026-04-10

### Added

- `loop_monitors` の judge に `provider`/`model` フィールドを追加。ジャッジムーブメントのプロバイダーとモデルを明示的に指定可能に (#599)
- `takt list --action sync` を非インタラクティブモードでサポート

### Changed

- Codex プロバイダーのリトライ戦略を強化: 最大リトライ回数を 3→9 に増加、ベース遅延を 250ms→1000ms に変更、"at capacity" エラーを自動リトライ対象に追加 (#614)

### Fixed

- ループモニタージャッジが常にデフォルトプロバイダーで実行される問題を修正。トリガー元ムーブメントのプロバイダー/モデル設定を継承するよう変更 (#599)
- 完了済みタスクのブランチ操作（merge/try-merge/diff）でルートブランチが欠落している場合にエラーとなる問題を修正。クローンから自動復元するよう改善 (#616)
- Phase 2 エラーイベント（`phase:complete`）が `phase:start` より先に発火されることがある問題を修正

### Internal

- テストを多数追加（codex-client-retry, engine-loop-monitors, it-completed-task-root-branch, it-piece-loader, provider-resolution, taskBranchLifecycleActions 等）
- `providerModelCompatibility` をコアモジュール（`src/core/piece/`）に移動
- タスク実行後のプッシュ処理を簡素化（clone 内フォールバック push を廃止し、ルートリポジトリ経由に一本化）
- git コマンドのエラーメッセージに stderr 詳細を含めるよう改善

## [0.35.2] - 2026-04-09

### Added

- `takt list` でスタックした実行中タスクを強制失敗にできる「Mark as failed」アクションを追加 (#604)
- タスクレコードに `run_slug` を追加し、実行中タスクの現在のステップ情報を `meta.json` から取得可能に

### Changed

- `write_tests` ムーブメントの出力契約を `test-scope.md` + `test-decisions.md` の2ファイルから `test-report.md` の1ファイルに簡素化

### Internal

- CI auto-tag ワークフローから冗長な build・test ステップを削除
- `RunMeta` 型を `src/core/piece/run/run-meta.ts` に抽出し、`currentStep`/`currentIteration` トラッキングを追加

## [0.35.1] - 2026-04-09

### Added

- タスク実行中に常時スピナーを表示: TTY 環境でタスク実行中にアニメーションスピナーを表示し、処理中であることを可視化
- Claude Headless の thinking ストリーム表示: ヘッドレスモードで thinking トークンをリアルタイム表示。parallel モードでは色分け表示に対応

### Changed

- SIGINT（Ctrl+C）でクローン作成中でも即座にプロセスを終了できるよう改善: `run`/`watch` コマンドで raw mode による即時検知を導入し、git サブプロセスを AbortSignal で中断可能に

### Fixed

- Codex プロバイダが Git リポジトリ外での実行を拒否する問題を修正

### Internal

- StatusLine の wrapWrite をアロー関数にリファクタリング
- StreamDisplay のハンドラーをムーブメントごとにキャッシュするよう最適化
- クローン作成関連のテスト追加・更新

## [0.35.0] - 2026-04-07

### Added

- Claude Headless プロバイダを追加: Claude CLI のヘッドレスモード（`claude --print`）をサブプロセスとして実行する新プロバイダ。`claude` プロバイダ名で利用可能 (#584)
- trace ログレベルを追加: `poll_tick`/`no_new_tasks` などの高頻度ログを抑制し、デバッグログの可読性を向上。`logging.trace: true` で有効化
- レガシー設定キーの非推奨警告: `piece_*`/`movement*` 系の旧キー使用時に deprecation warning を表示し、新しい `workflow_*`/`step*` キーへの移行を促進 (#581, #594)
- Mock プロバイダで `delayMs` と AbortSignal をサポート: SIGINT テスト等で利用可能に (#595)

### Changed

- **BREAKING:** `claude` プロバイダがヘッドレス CLI モードをデフォルトに変更。従来の SDK ベースプロバイダは `claude-sdk` として引き続き利用可能 (#584)
- クローン環境からのプッシュに relay push パターンを導入: 一時 ref 経由でプッシュすることで、チェックアウト中のブランチへの直接プッシュによるデータ損失を防止 (#592)
- PR 由来タスクのメタデータ伝搬を改善: `shouldPublishBranchToOrigin` フラグにより、ローカルプッシュ失敗時にクローンから直接 origin へプッシュするフォールバックを追加 (#592)
- dual/backend ワークフローの `max_steps` を 60 に増加

### Fixed

- `pr_body_template` が `--task` オプション実行時に無視される問題を修正 (#538)
- 既存 PR ブランチ更新時にリモートを正として worktree を作成するよう修正 (#557)
- SIGINT（Ctrl+C）が AI レスポンス待機中に正しくアボートされない問題を修正 (#595)
- mise 等のバージョン管理ツール環境下で Claude SDK サブプロセスの PATH が安定しない問題を修正 (#591)
- ジャッジムーブメントのプロバイダフォールバック解決が正しく機能しない問題を修正 (#577)
- exceeded 時のワークツリーパスが正しく解決されない問題を修正 (#575)
- PR 作成時のエラー詳細が失われる問題を修正
- non-fast-forward プッシュ拒否時にヒントメッセージを表示するよう改善

### Internal

- `.takt/config.yaml` の非推奨キーをリネーム
- レガシーワークフローキー非推奨警告の重複排除 (#594)
- `AgentSetup` から `claudeAgent`/`claudeSkill` フィールドを削除（Headless プロバイダ移行に伴い不要に）
- 型定義ファイルから冗長な JSDoc コメントを整理
- review-fix-takt-default ワークフローの max_steps を増加

## [0.34.0] - 2026-04-03

### Added

- StructuredCaller インターフェースを導入: プロバイダーのネイティブ構造化出力（Structured Output）をサポートし、ステータス判定・条件評価・タスク分解でテキストパースに代わる JSON ベースの応答抽出が可能に (#570)
- Traced Config を導入: `traced-config` パッケージによる設定値の出所追跡（環境変数・設定ファイル・デフォルト値）をサポート (#558)
- 並列ステップに `concurrency` フィールドを追加: セマフォベースの同時実行数制御が可能に
- 無効なワークフロー YAML のロード時に警告を表示するようになった（スキーマバリデーションエラーの詳細を表示） (#540)
- 計画・レビュー用ファセットを強化: planner・requirements-reviewer・supervisor のペルソナ、plan・requirements-review・supervisor-validation の出力契約、coding ポリシーを新規追加
- `takt add` コマンドで `--workflow` オプションによるワークフロー指定に対応

### Changed

- **BREAKING:** ワークフロー YAML のキーをリネーム: `movements` → `steps`、`initial_movement` → `initial_step`、`max_movements` → `max_steps`、`piece_config` → `workflow_config`。旧キーは互換エイリアスとして引き続き使用可能 (#576)
- **BREAKING:** ビルトインワークフローのディレクトリを `builtins/{lang}/pieces/` から `builtins/{lang}/workflows/` に移動。設定キーも `piece_categories` → `workflow_categories`、`enable_builtin_pieces` → `enable_builtin_workflows` にリネーム。旧キーは互換エイリアスとして引き続き使用可能 (#571, #561)
- **BREAKING:** CLI オプション `-w, --piece` を `-w, --workflow` にリネーム。`--piece` はレガシーエイリアスとして使用可能 (#576)
- **BREAKING:** ワークフロー YAML の `instruction_template` フィールドを削除。`instruction` フィールドを使用すること (#539)
- `takt-default` ワークフローの `max_steps` を 50 に増加（`default` は 30 のまま）
- 設定キーのエイリアス解決時に旧キーと新キーの両方が異なる値で存在する場合はエラーを発生させるよう変更

### Fixed

- Claude SDK のエラーペイロードが正しく処理されない問題を修正
- ワークフロー用語の統一: CLI ヘルプ、エラーメッセージ、ドキュメントを `workflow` / `step` 用語に更新
- ワークツリーモードで PR の Issue 解決がプロジェクト cwd から正しく行われるよう修正
- Cursor Agent のヘッドレスワークツリー実行で `--trust` フラグが渡されるよう修正
- ワークツリー環境下で `runtime.prepare` が設定されている場合にセルフホスト GitLab の `glab` CLI 認証が失敗する問題を修正 (#563)
- ピースプロバイダー解決の統一化

### Internal

- Zod スキーマを `schemas.ts` から `schema-base.ts`・`workflow-schemas.ts`・`config-schemas.ts` に分割
- 環境変数オーバーライドを spec ベースの宣言的定義にリファクタリング
- レガシーの `step_provider`・`step_model` フィールドを削除
- TeamLeader のパートタイムアウト処理を簡素化
- `yaml` パッケージを v2.8.3 に更新
- ドキュメント（README、CLI リファレンス、設定ガイド等）をワークフロー用語に全面更新

## [0.33.2] - 2026-03-26

### Added

- 読み取り専用の監査ピースを追加: `audit-architecture`, `audit-architecture-frontend`, `audit-architecture-backend`, `audit-architecture-dual`, `audit-e2e`, `audit-unit`。コードを変更せずにモジュール境界やカバレッジギャップを列挙し、Issue 作成可能なレポートを出力

### Changed

- `security-audit` ピースを `audit-security` にリネーム（監査ピース群の命名規則を統一）
- ビルトインピースカテゴリを再構成: 🧪 Testing カテゴリを廃止し、監査ピースを 🔍 Review カテゴリに統合
- `fill-unit`, `fill-e2e` ピースを削除（`audit-unit`, `audit-e2e` に置き換え）

### Fixed

- GitLab セルフホスト環境で worktree（共有クローン）実行時に MR 作成が失敗するバグを修正。Git プロバイダーの `cwd` がクローンパスに正しく伝播するよう変更 (#552)

### Internal

- Git プロバイダーの `cwd` 伝播に関するテストカバレッジを追加
- 設定ドキュメントから `verbose` オプションの記載を削除し、`logging.level` による設定方法に統一 (#543)

## [0.33.1] - 2026-03-24

### Changed

- ファイナルレビューとセキュリティレビューのガードレールを強化: supervisor のファセット、セキュリティナレッジ、レビューポリシー・インストラクションを拡充

### Fixed

- GitLab セルフホスト環境で `gitlab.com` の認証がない場合にタスク完了後の MR 作成が必ず失敗するバグを修正。`glab auth status` がリモートのホスト名を指定して認証チェックするよう変更 (#545)

### Internal

- GitLab プロバイダーのテストカバレッジを拡充（セルフホスト環境の認証チェック、ホスト名ベースの CLI ステータス検証）

## [0.33.0] - 2026-03-22

### Added

- GitLab VCS プロバイダーを追加: `glab` CLI を使った Issue 取得・マージリクエスト作成・レビューコメント取得に対応。git リモート URL からの自動検出をサポートし、`vcs_provider: gitlab` による明示的な設定も可能 (#512)
- インタラクティブモード用プロバイダー設定 (`takt_providers.assistant`) を追加: ピース実行とは独立したプロバイダー/モデルをインタラクティブモードに指定可能 (#483)

### Changed

- BREAKING: ピース YAML の MCP サーバー設定をデフォルト拒否に変更。使用するには `piece_mcp_servers` でトランスポート別に明示的に許可が必要 (#524)
- BREAKING: ピース YAML の Arpeggio カスタムコード（カスタムデータソース、インライン JS、外部マージファイル）をデフォルト拒否に変更。使用するには `piece_arpeggio` で明示的に許可が必要 (#521)
- BREAKING: ピース YAML の runtime prepare カスタムスクリプトをデフォルト拒否に変更（ビルトインプリセットは常に許可）。使用するには `piece_runtime_prepare.custom_scripts: true` が必要 (#520)
- BREAKING: sync conflict resolver の自動ツール承認をデフォルト拒否に変更。使用するには `sync_conflict_resolver.auto_approve_tools: true` が必要 (#522)
- team leader のタスク分解における最大ターン数を 4 → 5 に引き上げ (#511)
- supervisor ファセットを強化: 要件カバレッジのエビデンスベース検証を追加
- ペルソナファセットからクロスエージェント参照を除去し、ピース横断での再利用性を向上

### Fixed

- パイプラインモードで auto-commit の push 失敗時に PR 作成が無診断で失敗する問題を修正 (#532)
- `.takt/.gitignore` のファセットパスが実際のディレクトリ構造と不一致だった問題を修正 (#535)
- レビューピースの gather モードでブランチ検出が不正確だった問題を修正（完全一致を要求するよう変更） (#523)
- レビューピースで reject findings のフォーマットが正しく処理されない問題を修正 (#528)
- パイプラインモードでタスクブランチが PR 作成前に push されず、PR 作成が失敗する問題を修正

### Internal

- GitLab プロバイダーのテストカバレッジを追加（issue, pr, provider, utils）
- VCS プロバイダーの自動検出・ファクトリ・フォーマットのテストカバレッジを追加
- MCP サーバー・Arpeggio・runtime prepare・conflict resolver のデフォルト拒否に関するテストカバレッジを追加
- ピースローダーのテストカバレッジを大幅に拡充
- プロジェクト設定・グローバル設定のテストカバレッジを追加
- MCP サーバーヘルパー、ポリシー正規化、conflict resolver ヘルパーのリファクタリング
- ドキュメント更新（レビューピース名の修正、ビルトインカタログ更新）
- ビルド/lint/テスト品質ゲートの追加と E2E テスト環境の CLAUDECODE 環境変数分離
- テスト契約チェックのビルトインファセット強化（review-test, write-tests-first, testing-review）
- タスク auto-PR の E2E テストを追加

## [0.32.2] - 2026-03-17

### Added

- 到達経路（Reachability）ファセットを追加: 新しい画面・機能を追加する際に、ルーティング・メニュー・ボタン等のエントリーポイントを同時に整備することを計画・実装・レビューの各段階で検証
- 再取得ループ防止ファセットを追加: `useEffect` の依存配列に不安定な Context/Provider 関数参照を含めることで起きる無限ループを検出・防止するナレッジとポリシー
- UIライブラリ統合ファセットを追加: サードパーティ UI コンポーネント（データグリッド、日付ピッカー等）導入時のバージョン互換性・実マウント検証のナレッジとポリシー
- React ナレッジファセット (`react.md`) を新規追加: Effects の再実行制御、Context/Provider の値安定性に関する判断基準テーブル付き
- デザイン計画ポリシー (`design-planning.md`) を新規追加: デザインリファレンスが存在する場合の要素インベントリ・スコープ決定の基準
- フロントエンド専用プランフォーマット (`plan-frontend.md`) を新規追加: デザイン要素の Keep/Change 判定テーブルを含むプラン出力契約

### Changed

- フロントエンド系ピース（`frontend`, `frontend-mini`, `dual`, `dual-mini`, `dual-cqrs`, `dual-cqrs-mini`）の plan ムーブメントに `design-planning` ポリシーと `react` ナレッジを統合
- フロントエンド系ピースのプランフォーマットを `plan` から `plan-frontend` に変更
- `frontend` ピースの全ムーブメント（テスト、レビュー、修正等）に `react` ナレッジを追加

### Internal

- `@openai/codex-sdk` を 0.112.0 → 0.114.0 に更新
- team leader worker pool の E2E テストを安定化

## [0.32.1] - 2026-03-14

### Fixed

- `--pr` 経由のタスクで `autoPr` が無効になっていたため origin push がスキップされる問題を修正
- PR レビューコメントの取得が `gh pr view` の `reviews.comments` に依存していたため、インラインコメントを取りこぼす問題を修正。GitHub REST API によるページネーション取得に変更 (#489)
- config のパス指定で `~` チルダ展開が効かない問題を修正（`worktree_dir`、`*_cli_path`、`analytics.events_path` 等） (#496)
- auto-commit 時に git hooks/filter がそのまま実行され、TAKT 管理下のコミットが意図しない hooks の影響を受ける問題を修正。デフォルトで無効化し、`allow_git_hooks` / `allow_git_filters` で opt-in に変更 (#503)
- インタラクティブモードで初回入力時に不要な AI 呼び出しが発生していた問題を修正 (#504)
- Cursor provider でプロンプト文字列が CLI オプションとして解釈される可能性がある問題を修正（`--` セパレータを追加） (#500)
- snapshot ファイル名にムーブメント名がそのまま使われ、パストラバーサルが可能だった問題を修正 (#498)
- `provider_options` の優先順位で、環境変数・プロジェクト設定がムーブメント定義より低くなっていた問題を修正（セキュリティ設定がムーブメントで上書きされないよう変更） (#497)
- worktree パスの再利用時に、クローンベースディレクトリ外のパスが受け入れられる問題を修正 (#502)
- terraform ピースから不要な強制 full パーミッションを削除 (#507)

### Internal

- テスト系ピース・ファセットの全面整備（e2e-test → audit-e2e、unit-test → audit-unit にリネーム、ナレッジ・ポリシー追加）
- デザイン忠実度ポリシーの追加とフロントエンド系ピースへの統合
- audit-security ピースの追加
- ファセットデプロイメントのリファクタリング（templates ディレクトリの廃止、facets ディレクトリへの統合） (#505)
- `isPathInside` ユーティリティを追加し、クローン削除・worktree 再利用のパス検証を強化
- ループモニターの閾値調整とレビューポリシーの改善

## [0.32.0] - 2026-03-09

### Added

- `takt export-codex` コマンド: ピース/ファセットを Codex スキルとしてエクスポート (`~/.agents/skills/takt/`) (#475)
- `frontend` / `backend` / `backend-cqrs` ピースにテストファースト（`write_tests`）ムーブメントを追加し、レビューを2段階化（Stage 1: 構造・実装品質 → Stage 2: 安全性・品質保証）
- セキュリティナレッジにログ・マスキングセクションを追加（パスワード露出、`toString()` によるフィールド漏洩の検出基準）
- CQRS+ES ナレッジにマスタデータと CRUD の使い分けセクションを追加（6つの判断基準テーブル付き）
- `/ci` コメントで PR の CI を手動トリガーするワークフローを追加
- devcontainer で worktree クローン先の親ディレクトリが書き込み不可の場合に `.takt/worktrees/` へフォールバック
- インタラクティブモードのアシスタントが設計判断を勝手にしないようポリシーを追加

### Changed

- BREAKING: ピース YAML の `instruction_template` フィールドを非推奨化。`instruction` に統一（後方互換あり、deprecated 警告を表示） (#476)
- レビュー系ピースの命名規則を `review-{variant}` / `review-fix-{variant}` に統一
- タスク分解の REJECT 基準をナレッジからポリシーに分離
- faceted-prompting を npm パッケージ (`@anthropic-ai/faceted-prompting`) に移行し、内蔵コードを削除

### Fixed

- `takt run` の Slack 通知が当該 run で実行したタスクのみを送信するよう修正（従来は全タスクを通知していた）
- `ProviderPermissionProfilesSchema` に `copilot` が欠落していた問題を修正 (#487)
- PR fix フローで既存ブランチ存在時に `baseBranch` 検証をスキップするよう修正
- `review-fix-takt-default` の fix 後フローを `takt-default` と統一
- `write-tests-first` インストラクションからビルド検証手順を削除
- `cc-resolve` ワークフローに `actions: write` パーミッションを追加

### Internal

- SDK 依存パッケージを最新化
- `deploySkill` のコア処理を `deploySkillInternal` に抽出し、`deploySkillCodex` と共有
- clone ブランチ解決をリモートブランチ対応に拡張（`localBranchExists` / `remoteBranchExists` に分離）
- README の起動フローを整理し「タスクにつむ」を通常フローとして記載

## [0.31.0] - 2026-03-06

### Changed

- `dual` ピースを大幅強化: テストファースト（`write_tests`）ムーブメント追加、`implement` を team_leader 化（FE/BE 分割）、レビューを2段階化（`reviewers_1`: arch/frontend/testing → `reviewers_2`: security/qa/requirements）
- `takt-default-team-leader` ピースを `takt-default` に統合し削除。`takt-default` の `implement` を team_leader 化
- `quality_gates` のペルソナ単位オーバーライドをサポート: `piece_overrides.personas.<name>.qualityGates` で特定ペルソナのムーブメントに品質ゲートを追加可能に (#472)
- Status 型を `done` / `blocked` / `error` の3値に整理し、ステータスハンドリングを厳格化。`blocked` / `error` 時は即座に ABORT するよう変更 (#477)

### Fixed

- `git check-ref-format` コマンドから不要な `--` を削除し、ブランチ名の検証が正しく動作するよう修正 (#481)
- `log_level` → `logging.level` の設定キー不整合を修正（E2E テスト全滅の原因）
- Phase 3 ステータス判定が失敗した際に Phase 1 のルール評価にフォールバックするよう修正（従来はエラーで中断していた） (#474)
- Parallel ムーブメントの Phase 3 判定失敗時も同様にフォールバック対応 (#474)
- タスクリトライ・追加指示時のピース名取得元を `runInfo?.piece` から `task.data?.piece` に変更（worktree 内で `runInfo` が常に null になる問題を修正）

### Internal

- config 3層モデルの整理: `PersistedGlobalConfig` → `GlobalConfig` にリネーム、マイグレーション用フォールバック処理を削除、`persisted-global-config.ts` → `config-types.ts` にリネーム
- supervisor ペルソナからインラインの知識・ポリシーをファセットファイルに分離
- team leader の分解品質を改善するナレッジ（`task-decomposition.md`）とインストラクション（`dual-team-leader-implement.md`）を追加
- `~/.takt/config.yaml` テンプレートに不足していた設定項目を追加
- Provider Sandbox & Permission ガイドのドキュメントを拡充

## [0.30.0] - 2026-03-05

### Added

- トレースレポートの自動生成: piece 実行完了時に movement の遷移・フェーズ・ルール評価結果を Markdown レポートとして `.takt/runs/` に自動出力。`logging.trace: true` で全文モード、デフォルトは redacted モード (#467)
- 使用量イベントログ: プロバイダー呼び出しごとのトークン使用量を NDJSON 形式で記録。`logging.usage_events: true` で有効化 (#470)
- タスクリトライ時のピース再利用確認: `takt list` からリトライ・追加指示する際に、前回と同じピースを使うか選び直すかを選択可能に (#468)

### Changed

- BREAKING: `takt switch` コマンドを削除。ピース選択はインタラクティブモード起動時（`takt`）に毎回行う方式に変更 (#465)
- Claude プロバイダーの `allowed_tools` をビルトインピースの YAML 定義からエグゼキューター側に移動し、ピース YAML の簡素化と保守性を向上 (#469)
- 設定構造をリファクタリング: `globalConfig.ts` を `globalConfigCore.ts`・`globalConfigAccessors.ts`・`globalConfigResolvers.ts`・`globalConfigSerializer.ts` に分割。プロジェクトローカル設定（`.takt/config.yaml`）のフォールバック優先度を明確化 (#460)
- observability モジュールを `core/logging/` に再編成: `providerEventLogger` と `usageEventLogger` を統一的なログ基盤として整理 (#466)
- レビュアー全体に `coder-decisions.md` の参照を追加し、コーダーの設計判断を考慮したレビューで誤検知を抑制
- レビュー↔修正ループの収束を支援: レポート履歴の参照、ループモニター、修正方針のガイドラインを整備

### Fixed

- runtime 環境の `XDG_CONFIG_HOME` 上書きで `gh` CLI の認証が失敗する問題を修正。`GH_CONFIG_DIR` を元の設定から保持するよう変更
- `.takt/config.yaml` に `runtime.prepare` を記述するとエラーになる問題を修正（プロジェクトレベルでの runtime 設定を許可） (#464)
- インタラクティブモードで iteration limit 到達時にプロンプトが表示されず、exceeded 状態が保持されない問題を修正
- PR 作成失敗時のタスクステータスを `failed` から `pr_failed` に分離し、実行成功だが PR 作成のみ失敗したケースを区別可能に
- リトライ時にタスクにピース情報が引き継がれるよう修正
- `.gitignore` の `.takt/` ディレクトリ ignore を削除し `.takt/.gitignore` に委譲（プロジェクト設定ファイルの追跡を可能に）
- CI: push トリガーから `takt/**` を削除し二重実行を防止
- `cc-resolve` ワークフローで push 後に CI を自動トリガーするよう修正

### Internal

- deprecated config マイグレーション処理を削除
- プロジェクトローカル設定の優先度に関する統合テストを追加
- テストヘルパーとテストセットアップの改善

## [0.29.0] - 2026-03-04

### Added

- レビュー＋修正ループピース群を追加: `review-fix`（多角レビュー）、`frontend-review-fix`、`backend-review-fix`、`dual-review-fix`、`dual-cqrs-review-fix`、`backend-cqrs-review-fix` および対応するレビュー専用ピース群を追加。コードレビューと自動修正を反復するワークフロー
- `takt-default-review-fix` ピースを追加: TAKT 自己開発向けのレビュー＋修正ループワークフロー
- `quality_gates` のグローバル/プロジェクトレベルオーバーライドをサポート: `~/.takt/config.yaml` および `.takt/config.yaml` の `piece_overrides.quality_gates` でビルトインピースの品質ゲートを上書き可能に (#384)
- タスクの `base_branch` 設定: `takt add` 時に現在のブランチを base_branch として記録し、タスク実行時にそのブランチから分岐するよう設定可能に (#455)
- プロバイダー設定の統一: `.takt/config.yaml` で `provider` ブロックに `type`/`model`/プロバイダー固有オプション（`network_access` 等）をまとめて記述可能に (#457)
- ワーカープール超過時のリキュー: タスク実行がワーカー上限を超えた場合、タスクを自動的に再キューイングするよう対応 (#366)
- `--pr` インタラクティブモードで `create_issue` アクションを除外し、`save_task` 時に PR のブランチ名を `base_branch` として自動設定
- team_leader の `decomposeTask`/`requestMoreParts`/Phase 3 ステータス判定のプロバイダーイベントをロギング: `provider-events.jsonl` に記録されるようになり、デバッグ・分析が可能に

### Fixed

- `export-cc` で `facets/` のサブディレクトリ構造（`personas/`、`policies/` 等）が出力先に再現されなかった問題を修正 (#8dcb23b)
- `cc-resolve` コマンドがコンフリクト解決後にマージコミットを生成するよう修正 (#1b1f758)
- グローバル設定 (`~/.takt/config.yaml`) の `piece` フィールドがピース解決チェーンで無視されるバグを修正 (#458)
- Codex プロバイダーでプロバイダー優先のパーミッションモード解決が機能しない問題と EPERM エラーの E2E テストを追加 (#d2b48fd)
- レビューコメントがない PR で `--pr` を使用した際にエラーになる問題を修正
- `--auto-pr`/`--draft` オプションをパイプラインモード専用に制限（インタラクティブモードでの誤用を防止）
- team_leader のストリーミングでバウンダリの先行フラッシュによる断片化を修正 (#769bd87, #bddb66f)
- team_leader のエラーメッセージが空文字列になるバグを修正 (#52968ac)
- `decomposeTask`/`requestMoreParts` の `maxTurns` を 2 から 4 に増加（複雑なタスク分解でタイムアウトしていた問題を緩和）
- Copilot プロバイダーのクライアント実装のバグを修正 (#434)

### Internal

- E2E プロバイダー別テストをコンフィグレベル（`vitest.config.e2e.provider.ts`）で振り分けるよう変更。テストファイル内の `skip` ロジックを廃止し、JSON レポート出力を追加
- 共有ノーマライザを `configNormalizers.ts` に抽出してプロバイダー設定解析を整理
- `agent-usecases`/`schema-loader` を移動し `pieceExecution` の責務を分割
- `check:release` で全プロバイダー（claude/codex/opencode）の E2E を実行するよう変更
- CI: PR と push の重複実行を concurrency グループで抑制
- CI: feature ブランチへの push と手動実行に対応

## [0.28.1] - 2026-03-02

### Changed

- BREAKING: `expert` / `expert-mini` / `expert-cqrs` / `expert-cqrs-mini` ピースを `dual` / `dual-mini` / `dual-cqrs` / `dual-cqrs-mini` にリネーム。カスタマイズしている場合はピース名の更新が必要
- `default-mini` / `default-test-first-mini` ピースを `default` に統合。`default` ピースが「テスト優先モード」を内包するよう拡張
- `coding-pitfalls` ナレッジの主要項目を `coding` ポリシーに移動し、ポリシーとして実際に適用されるよう強化
- `implement` / `plan` インストラクションにセルフチェック・コーダー指針を追加

### Removed

- `passthrough` ピースを削除
- `structural-reform` ピースを削除

### Internal

- `expert-supervisor` ペルソナを `dual-supervisor` にリネーム
- ビルトインカタログに不足していた `terraform`、`takt-default` 系、`deep-research` を追加
- カテゴリ設定に `deep-research` を追加
- 全ドキュメントに `copilot` プロバイダーの説明を追加し、Claude Code 寄りの記述をプロバイダー中立に修正

## [0.28.0] - 2026-03-02

### Added

- GitHub Copilot CLI プロバイダーを追加: `copilot` プロバイダーとして GitHub Copilot CLI を利用可能に。セッション継続、パーミッション制御（readonly/edit/full）に対応。`copilotCliPath` / `TAKT_COPILOT_CLI_PATH` で CLI パスを指定、`copilotGithubToken` / `TAKT_COPILOT_GITHUB_TOKEN` で認証トークンを設定 (#425)
- `--pr` オプションを追加: PR のレビューコメントを取得してタスクとして実行。パイプラインモードとインタラクティブモードの両方で利用可能 (#421)
- `takt add --pr N` で PR のレビューコメントをタスクとして追加可能に。PR のブランチ名で worktree を自動作成し、レビュー指摘の修正タスクとしてキューイング (#426)
- `takt list` に「Pull from remote」アクションを追加: リモートの変更を worktree に取り込み、再プッシュ可能に (#395)
- プロジェクト単位の CLI パス設定: `.takt/config.yaml` で `claudeCliPath` / `cursorCliPath` / `codexCliPath` / `copilotCliPath` をプロジェクトごとに設定可能に (#413)
- インタラクティブモードのスラッシュコマンドを行末でも認識可能に（例: `タスクの内容 /go`）(#406)
- takt-default / takt-default-team-leader ビルトインピースを追加（TAKT 自己開発用のワークフロー定義）
- TAKT ナレッジファセット（`takt.md`）を追加: TAKT のアーキテクチャとコード規約を体系化
- ai-antipattern ポリシーに冗長な条件分岐パターン検出を追加: 同一関数を if/else で呼び分けるコードを検出し、三項演算子やスプレッド構文での統一を促す

### Fixed

- 不正な `tasks.yaml` を検出した場合、ファイルを削除せず保持してエラーメッセージで停止するよう修正 (#418)
- shallow clone リポジトリで worktree 作成が失敗する問題を修正: `--reference` 付きクローンが失敗した場合に通常クローンへフォールバック (#376, #409)
- グローバル/プロジェクト設定の `model` がモデルログに反映されない不具合を修正 (#417)
- fork PR レビュー時に `GH_REPO` を設定して正しいリポジトリの issue を参照するよう修正
- takt-review ワークフローの PR コメント投稿ステップにも `GH_REPO` を設定

### Internal

- `resolveConfigValue` の不要な `defaultValue` 引数を削除し、設定解決ロジックを簡素化 (#391)
- PRコメント `/resolve` でコンフリクト解決・レビュー指摘修正を行う GitHub Actions ワークフロー（cc-resolve）を追加
- takt-review ワークフローを `pull_request_target` に変更し、fork PR でもシークレットを利用可能に
- CI に `ready_for_review` / `reopened` トリガーを追加
- CONTRIBUTING にレビューモードの例を追加、日本語版（`CONTRIBUTING.ja.md`）を追加

## [0.28.0-alpha.1] - 2026-02-28

### Added

- GitHub Copilot CLI プロバイダーを追加: `copilot` プロバイダーとして GitHub Copilot CLI を利用可能に。セッション継続、パーミッション制御（readonly/edit/full）に対応。`copilotCliPath` / `TAKT_COPILOT_CLI_PATH` で CLI パスを指定、`copilotGithubToken` / `TAKT_COPILOT_GITHUB_TOKEN` で認証トークンを設定 (#425)
- `--pr` オプションを追加: PR のレビューコメントを取得してタスクとして実行。パイプラインモードとインタラクティブモードの両方で利用可能 (#421)
- `takt add --pr N` で PR のレビューコメントをタスクとして追加可能に。PR のブランチ名で worktree を自動作成し、レビュー指摘の修正タスクとしてキューイング (#426)
- `takt list` に「Pull from remote」アクションを追加: リモートの変更を worktree に取り込み、再プッシュ可能に (#395)
- プロジェクト単位の CLI パス設定: `.takt/config.yaml` で `claudeCliPath` / `cursorCliPath` / `codexCliPath` / `copilotCliPath` をプロジェクトごとに設定可能に (#413)
- インタラクティブモードのスラッシュコマンドを行末でも認識可能に（例: `タスクの内容 /go`）(#406)
- takt-default / takt-default-team-leader ビルトインピースを追加（TAKT 自己開発用のワークフロー定義）
- TAKT ナレッジファセット（`takt.md`）を追加: TAKT のアーキテクチャとコード規約を体系化
- ai-antipattern ポリシーに冗長な条件分岐パターン検出を追加: 同一関数を if/else で呼び分けるコードを検出し、三項演算子やスプレッド構文での統一を促す

### Fixed

- 不正な `tasks.yaml` を検出した場合、ファイルを削除せず保持してエラーメッセージで停止するよう修正 (#418)
- shallow clone リポジトリで worktree 作成が失敗する問題を修正: `--reference` 付きクローンが失敗した場合に通常クローンへフォールバック (#376, #409)
- グローバル/プロジェクト設定の `model` がモデルログに反映されない不具合を修正 (#417)
- fork PR レビュー時に `GH_REPO` を設定して正しいリポジトリの issue を参照するよう修正
- takt-review ワークフローの PR コメント投稿ステップにも `GH_REPO` を設定

### Internal

- `resolveConfigValue` の不要な `defaultValue` 引数を削除し、設定解決ロジックを簡素化 (#391)
- PRコメント `/resolve` でコンフリクト解決・レビュー指摘修正を行う GitHub Actions ワークフロー（cc-resolve）を追加
- takt-review ワークフローを `pull_request_target` に変更し、fork PR でもシークレットを利用可能に
- CI に `ready_for_review` / `reopened` トリガーを追加
- CONTRIBUTING にレビューモードの例を追加、日本語版（`CONTRIBUTING.ja.md`）を追加

## [0.27.0] - 2026-02-28

### Added

- Cursor Agent CLI プロバイダーを追加: `cursor-agent` CLI を介して Cursor を AI プロバイダーとして利用可能に。API キー（`TAKT_CURSOR_API_KEY` / `cursor_api_key`）または `cursor-agent login` セッションで認証、JSON 出力解析、セッション継続（`--resume`）、モデル指定（`--model`）、パーミッション制御（`full` → `--force`）に対応 (#403)
- Cursor プロバイダーの E2E テスト設定を追加（`vitest.config.e2e.cursor.ts`、`npm run test:e2e:cursor`）

### Fixed

- Phase 1 が error または blocked を返した場合に Phase 2（レポート出力）をスキップするよう修正。Phase 1 失敗時に不要なレポート生成が実行される問題を解消
- Codex 互換性のため、runtime prepare で Gradle デーモンを無効化するよう修正

### Internal

- エージェント/カスタムペルソナのドキュメントを整合

## [0.26.0] - 2026-02-27

### Added

- TeamLeader に refill threshold と動的パート追加を導入: 実行中のパートが `refill_threshold` 以下になると、リーダーが完了済みパートの結果を評価して追加パートを動的に生成。`max_parts` は同時並行数、`refill_threshold` で追加計画のタイミングを制御（最大合計 20 パートまで）
- deep-research ピースの dig ムーブメントに `team_leader` 設定を追加し、リサーチの並列実行が可能に
- TeamLeader が Phase 2（レポート出力）/ Phase 3（ステータス判定）を通常ムーブメントと同様にサポート（`applyPostExecutionPhases` の共通化）
- ParallelLogger が動的なサブムーブメント追加に対応（`addSubMovement`）し、TeamLeader の動的パート追加時にもストリーミング出力を表示
- `LineTimeSliceBuffer` を導入し、並列ストリーミング出力のバッファリングを時間スライスベースで最適化
- プロジェクト設定（`.takt/config.yaml`）で `model` 指定をサポート

### Changed

- BREAKING: カスタムエージェント定義（`~/.takt/personas/*.md`）の `provider` / `model` を解釈しない方針とし、エージェントのプロバイダー・モデルはピース側の解決ロジック（CLI → persona_providers → ステップ → ローカル → グローバル）に統一 (#390)
- エージェントの provider/model 解決ロジックを `resolveAgentProviderModel` に一元化し、ムーブメント解決と同じ優先順位チェーンを使用するよう変更 (#386)
- `movement:start` イベントが `providerInfo` を含むよう変更し、表示側でのプロバイダー再解決を不要に (#390)
- `takt list` の「Sync with root」を「Merge from root」にリネーム (#394)
- インタラクティブモードの要約 AI がセッション非継承で実行されるよう修正し、会話コンテキストの汚染を防止 (#368)
- interactive policy のガイドラインを改善: ユーザーが「自分で調べて」と指示した場合と、ピースへの指示作成を区別するルールを明確化

### Fixed

- default / default-test-first-mini ピースの `write_tests` ムーブメントで、テスト対象が未実装の場合にスキップして implement へ進むルールを追加（従来は ABORT になっていた）(#396)
- `takt add` の GitHub Issue タイトル抽出を改善: Markdown 見出し（h1-h3）を優先的にタイトルとして使用するよう変更（従来は先頭行がそのまま使われていた）(#368)
- quiet モードの要約 AI がセッションを引き継がない問題を修正 (#368)
- `repertoire add` の `gh api` 呼び出しにバッファサイズ上限（100MB）を設定し、大きなリポジトリでのバッファオーバーフローを防止
- E2E テストで `gh` ユーザー検索が無効な場合にローカルリポジトリへフォールバックするよう修正

### Internal

- TeamLeaderRunner をリファクタリング: 実行ロジック（`team-leader-execution.ts`）、集約（`team-leader-aggregation.ts`）、共通ユーティリティ（`team-leader-common.ts`）、ストリーミング（`team-leader-streaming.ts`）に分離
- `more-parts.json` スキーマと `loadMorePartsSchema` ローダーを追加
- AGENTS.md を更新（プロジェクト構成とガイドラインの改訂）
- テスト拡充: provider/model 解決マトリクス、TeamLeader refill threshold / worker pool / aggregation / execution、OptionsBuilder、stream-buffer、conversationLoop resume、quietMode session、createIssueFromTask、schema-loader

## [0.25.0] - 2026-02-26

### Added

- Terraform/AWS ピース: IaC 開発用の完全なピースとファセット一式を追加。plan → implement → 並列3レビュー（architect/QA/security）→ supervise → complete の15ムーブメント構成（EN/JA）
- GitProvider 抽象化: Git/GitHub 操作を `GitProvider` インターフェースに統一し、将来の複数 Git プロバイダー対応の基盤を構築 (#375)
- プロジェクト設定で submodule の自動取得をサポート: `submodules: all` または `submodules: [path1, path2]` で指定可能に (#387)
- `takt add` で GitHub Issue 作成時にラベルをインタラクティブに選択可能に (#377, #111)
- deep-research ピースにデータ保存・レポート出力機能を追加（dig/analyze ムーブメントに Write・Bash ツール許可、supervise に research-report 出力契約）
- GitHub Discussions・Discord・X への一斉アナウンス GitHub Actions ワークフローを追加

### Changed

- default ピースをテスト先行開発構成に変更: plan の後に `write_tests` ムーブメントを追加し、テストを先に書いてから実装する流れに。並列レビューに testing-review を追加（3→4 レビュアー）。レポートファイル名をセマンティック命名に統一（`00-plan.md` → `plan.md` 等）
- sync with root をピースエンジン経由からプロバイダー抽象化を利用した単発エージェント呼び出しに簡素化。コンフリクト解決プロンプトをテンプレートファイル化（EN/JA 分離）

### Fixed

- lineEditor でサロゲートペア（絵文字等）のカーソル位置がずれる問題を修正。Ctrl+J による改行挿入を追加
- `--task` オプションでの直接実行時に tasks.yaml へ不要な記録がされる問題を修正
- `--task` でワークツリー作成時は tasks.yaml に記録するよう修正（`takt list` でのブランチ管理に必要）
- プロバイダー解決: 暗黙の `claude` フォールバックを廃止し、プロバイダーを解決できない場合は Fail Fast で終了するよう修正 (#386)
- プロバイダー解決: 表示用と実行用の provider/model 解決を `movement:start` イベントの providerInfo に一元化し、表示されるプロバイダーと実行プロバイダーの一致を構造的に保証 (#390)
- E2E テスト config-priority の不安定性を修正 (#388)

### Internal

- GitProvider 抽象化に伴うテスト追加（github-provider, taskGit）と既存テストのインポート更新
- CLAUDE.md 更新

## [0.24.0] - 2026-02-24

### Added

- AskUserQuestion 対応: AI エージェントが実行中に対話的にユーザーへ質問可能に。単一選択・複数選択・自由入力の TTY UI を提供。ピース実行中は自動的に拒否しエージェントの自律性を維持 (#161, #369)
- `review` ビルトインピースを3モード自動判定に拡張: PR 番号・ブランチ名・フリーテキストから自動でレビューモード（PR/ブランチ/作業中差分）を判定し、5並列レビュー（arch/security/qa/testing/requirements）を実行
- `testing-reviewer` と `requirements-reviewer` ビルトインペルソナを追加（専門レビュー観点）
- `testing` ポリシー: インテグレーションテスト必要条件を追加（3+モジュールのデータフロー、ワークフローへの状態マージ、コールチェーンを通じたオプション伝搬）
- `gather-review` インストラクションと `review-gather` 出力契約を追加（review ピースの gather ムーブメント用）
- `requirements-review` インストラクションと出力契約を追加（要件レビュー用）
- `testing-review` 出力契約を追加（テストレビュー用）
- SDK オプションに `settingSources: ['project']` を追加: CLAUDE.md の読み込みを Claude SDK に委譲し、プロジェクトレベル設定を適切に解決

### Changed

- **BREAKING:** `review-only` ピースを `review` にリネーム、`review-fix-minimal` ピースを削除 — これらのピース名を参照しているユーザーは `review` に更新が必要
- `write-tests-first` インストラクションに具体的なインテグレーションテスト判断基準を追加（「適宜 E2E テストを作成」から置き換え）

### Fixed

- planner ペルソナ: バグ修正の波及確認ルール（関連ファイルで同一パターンを grep）と、確認事項の判断保留禁止を追加

### Internal

- ドキュメント整備: 音楽メタファーの由来説明追加、カタログ漏れ・リンク切れ・孤立ドキュメント・イベント名・API Key 参照・eject 説明を修正、YAML 例から不要な personas セクションマップを削除、レガシー用語をコードベースの実態に合わせて修正
- 新規テストスイート: `StreamDisplay`、`ask-user-question-handler`、`pieceExecution-ask-user-question`、`review-piece`、`opencode-client-cleanup`
- レガシー `review-only-piece` テストと session モジュールの `loadProjectContext` を削除（CLAUDE.md 読み込みは SDK に委譲）

## [0.23.0] - 2026-02-23

### Added

- `default-test-first-mini` ビルトインピースを追加（テストファースト開発ワークフロー）
- `auto_fetch` グローバル設定: クローン作成前にリモートを fetch してクローンを最新に保つオプション（`default: false`）
- `base_branch` 設定（グローバル/プロジェクト）: クローン作成のベースブランチを指定（デフォルトはリモートのデフォルトブランチ）
- `model` プロジェクト設定: プロジェクトレベルでモデルを上書き（`.takt/config.yaml`）
- `concurrency` プロジェクト設定: プロジェクトごとに `takt run` の並列タスク数を設定
- パイプラインモードで `--create-worktree` をサポート（worktree ベースの実行）
- `skipTaskList` オプション: 対話モードの「実行する」アクションで `tasks.yaml` への追加をスキップ
- `takt list` でタスク名の横に GitHub Issue 番号を表示
- 失敗タスクのリトライ時、ピース選択の前に前回使用したピースの再利用を提案
- パイプラインモードの Slack 通知: タスク詳細、実行時間、ブランチ、PR URL を含むサマリを送信
- CI ワークフロー: PR に対して lint、test、e2e:mock チェックを自動実行 (#364)

### Changed

- Provider/Model 解決を `resolveProviderModelCandidates()` に一元化 — `AgentRunner` と `resolveMovementProviderModel` で同一の解決関数を使用
- パイプライン実行を薄いオーケストレーター (`execute.ts`) + ステップ実装 (`steps.ts`) にリファクタリング
- クローンディレクトリのデフォルト名を `takt-worktree`（単数）から `takt-worktrees`（複数）に変更（レガシーディレクトリの自動マイグレーション付き）
- PR タイトルに Issue 番号プレフィックスを追加（例: `[#6] Fix the bug`）
- タスクステータスが PR 作成失敗を反映するよう改善 — 以前はピース実行の成功のみを追跡
- `auto-tag.yml` がマージコミットではなく PR head SHA にタグを付与（ホットフィックスの正しいコード publish のため）
- セッションリーダーが `sessions-index.json` が欠損・不正な場合に JSONL ファイルスキャンにフォールバック
- `ProjectLocalConfig` 型をキャメルケースに正規化（`auto_pr`→`autoPr`、`draft_pr`→`draftPr`）— YAML のスネークケースは維持
- `getLocalLayerValue` を switch-case から動的プロパティルックアップに簡素化

### Fixed

- `repertoire add` のパイプ stdin: readline がバッファ済み行を破棄するため複数の `confirm()` 呼び出しが失敗する問題を修正 (#334)
- `AgentRunner` での movement provider 上書き優先順位: step provider がグローバル設定に誤って上書きされていた問題を修正
- プロジェクトレベルの `model` 設定が無視されていた問題 — `getLocalLayerValue` に `model` ケースが欠落していた
- PR 作成失敗がタスク失敗として適切に伝搬されるよう修正（エラーメッセージ付き）(#345)
- Claude セッション resume 候補が `sessions-index.json` 利用不可時に JSONL ファイルスキャンにフォールバック

### Internal

- CI: PR チェック用に lint、test、e2e:mock を追加（`ci.yml`）
- repertoire の e2e テストカバレッジを拡充 (#364)
- 新規テストスイート: clone、config、postExecution、session-reader、selectAndExecute-skipTaskList、taskStatusLabel、pipelineExecution
- リファクタリング: プロジェクト設定のケース正規化 (#358)、クローンマネージャー (#359)、パイプラインステップ抽出、confirm パイプリーダーシングルトン、provider 解決 (#362)

## [0.22.0] - 2026-02-22

### Added

- **Repertoire パッケージシステム** (`takt repertoire add/remove/list`): GitHub から外部 TAKT パッケージをインポート・管理 — `takt repertoire add github:{owner}/{repo}@{ref}` でパッケージを `~/.takt/repertoire/` にダウンロード。アトミックなインストール、バージョン互換チェック、ロックファイル生成、確認前のパッケージ内容サマリ表示に対応
- **@scope 参照**: piece YAML のファセット参照で `@{owner}/{repo}/{facet-name}` 構文をサポート — インストール済み repertoire パッケージのファセットを直接参照可能（例: `persona: @nrslib/takt-fullstack/expert-coder`）
- **4層ファセット解決**: 3層（project → user → builtin）から4層（package-local → project → user → builtin）に拡張 — repertoire パッケージのピースは自パッケージ内のファセットを最優先で解決
- **ピース選択に repertoire カテゴリ追加**: インストール済みの repertoire パッケージがピース選択 UI の「repertoire」カテゴリにサブカテゴリとして自動表示
- **implement/fix インストラクションにビルドゲート追加**: `implement` と `fix` のビルトインインストラクションでテスト実行前にビルド（型チェック）の実行を必須化
- **Repertoire パッケージドキュメント追加**: repertoire パッケージシステムの包括的なドキュメントを追加（[en](./repertoire.md), [ja](./repertoire.ja.md)）

### Changed

- **BREAKING: ファセットディレクトリ構造の変更**: 全レイヤーでファセットディレクトリが `facets/` サブディレクトリ配下に移動 — `builtins/{lang}/{facetType}/` → `builtins/{lang}/facets/{facetType}/`、`~/.takt/{facetType}/` → `~/.takt/facets/{facetType}/`、`.takt/{facetType}/` → `.takt/facets/{facetType}/`。マイグレーション: カスタムファセットファイルを新しい `facets/` サブディレクトリに移動してください
- 契約文字列のハードコード散在防止ルールをコーディングポリシーとアーキテクチャレビューインストラクションに追加

### Fixed

- オーバーライドピースの検証が repertoire スコープを含むリゾルバー経由で実行されるよう修正
- `takt export-cc` が新しい `builtins/{lang}/facets/` ディレクトリ構造からファセットを読み込むよう修正
- `confirm()` プロンプトがパイプ経由の stdin に対応（例: `echo "y" | takt repertoire add ...`）
- イテレーション入力待ち中の `poll_tick` デバッグログ連続出力を抑制
- ピースリゾルバーの `stat()` 呼び出しでアクセス不能エントリ時にクラッシュせずエラーハンドリング

### Internal

- Repertoire テストスイート: atomic-update, repertoire-paths, file-filter, github-ref-resolver, github-spec, list, lock-file, pack-summary, package-facet-resolution, remove-reference-check, remove, takt-repertoire-config, tar-parser, takt-repertoire-schema
- `src/faceted-prompting/scope.ts` を追加（@scope 参照のパース・バリデーション・解決）
- faceted-prompting モジュールの scope-ref テストを追加
- `inputWait.ts` を追加（ワーカープールのログノイズ抑制のための入力待ち状態共有）
- piece-selection-branches および repertoire の e2e テストを追加

## [0.21.0] - 2026-02-20

### Added

- **Slack タスク通知の拡張**: Slack Webhook 通知にリッチなタスクコンテキストとフォーマットを追加 (#316)
- **`takt list --delete-all` オプション**: タスクリストから全タスクを一括削除 (#322)
- **`--draft-pr` オプション**: `--draft-pr` フラグでドラフト PR を作成可能に (#323)
- **`--sync-with-root` オプション**: ワークツリーブランチをルートリポジトリの変更と同期 (#325)
- **ペルソナプロバイダーごとのモデル指定**: persona-provider レベルでモデルオーバーライドを指定可能に (#324)
- **Analytics のプロジェクト設定・環境変数オーバーライド対応**: Analytics 設定をプロジェクトごとに設定し、環境変数で上書き可能に
- **CI 依存パッケージヘルスチェック**: 依存パッケージの破損を検知する定期 CI チェックを追加

### Changed

- **設定システムの刷新**: `loadConfig()` による一括マージを廃止し、`resolveConfigValue()` によるキー単位解決に移行 — global < piece < project < env の優先順位でソーストラッキングと `OptionsBuilder` のマージ方向を制御 (#324)

### Fixed

- **retry コマンドの有効範囲と案内文を修正**: 正しい範囲と案内テキストを表示するよう修正
- **retry タスクの `completed_at` クリア漏れ**: `startReExecution` で失敗タスクを running に戻す際、`completed_at` を null にリセットするよう修正（Zod バリデーションエラーを防止）
- **OpenCode の2ターン目ハング修正**: `streamAbortController.signal` をサーバー起動から除外し、`sessionId` の引き継ぎを復元することで複数ターンの会話継続を実現
- **ローマ字変換のスタックオーバーフロー防止**: 長いタスク名でのローマ字変換時にスタックオーバーフローが発生する問題を修正

## [0.20.1] - 2026-02-20

### Fixed

- `@opencode-ai/sdk` を `<1.2.7` にピン留め — v1.2.7 以降のビルド成果物で v2 exports が壊れており、`npm install -g takt` 時に `Cannot find module` エラーが発生する問題を修正 (#329)

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
- ピース実行中の macOS アイドルスリープ防止を設定で有効化 (#100)

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
