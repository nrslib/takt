# 文言固定テストの監査（2026-09-26）

基準コミット: `3441c7cea`。対象はテストとテスト分類であり、製品コード、翻訳、プロンプト、配布ワークフローの振る舞いは変更しない。

## 調査方法と判断基準

`src/__tests__`、`e2e`、`web-ui`、`tools`、`scripts` の842テストファイルを走査した。TypeScript ASTで文字列を直接引数に取るassertionから、25文字以上または日本語を含む1,993件を候補として抽出した。これは違反件数ではない。配列・オブジェクト内の期待値、正規表現、変数経由の期待値はこの件数に含まれないため、配布資産の読み取り、プロンプト合成、翻訳、診断の周辺テストも直接確認した。さらに `eval/asserts`、`eval/providers`、suite registryを検索し、自然言語・YAMLソースの固定が集中していた評価準備テストを確認した。

判定には `builtins/ja/facets/policies/testing.md` と `ai-antipattern.md` の契約基準を使用した。

- 言い換えだけで失敗し、入力・出力・副作用の違いを検出しないassertionは削除する。
- 配布YAMLのstep一覧、遷移表、facet配置の丸写しは削除する。
- 翻訳の適用、変数展開、ユーザー入力・ファイル内容の受け渡しは残す。
- パーサーのトークン、JSON、CLI引数、ステータス、URL、パス、エラーの原因情報、秘匿化は文字列でも契約なので残す。
- モデルが正しく判断するかは自然言語の部分一致では証明しない。通常テストの合成検証と、シナリオによるモデル評価を区別する。

## 整理した対象と残る検証

| 対象 | 問題・整理 | 残る契約の検証 |
| --- | --- | --- |
| `web-ui-i18n` / `web-ui-execution-model` / `it-web-ui-retry-dom` | 翻訳文や説明文を期待値へ複製 | 言語切替、保存、変数展開、翻訳キーとDOM属性の対応、操作後の選択・API呼び出し |
| `initialization` / `i18n` | 選択肢の長い説明文、特定用語による翻訳判定 | provider値、選択結果、既定値、翻訳キーの解決 |
| `instruction-builder-reference-content` | 日本語の省略案内を固定 | 元内容の先頭を保持、末尾を省略、全文参照パスを保持 |
| `step-executor` | structured outputの日本語指示を複製 | 実際のbuilderへ日本語とschemaが伝わった出力を照合 |
| `workflowLoader` | Workflow Maker、review-fixの定義を丸写し。Teamの既定companion一覧を複製 | `workflowDiscovery` の両言語全件ロード、専用fixtureのloader/parser、渡したcompanion選択・親レポートの受け渡し |
| `loop-analysis-prompt-composition` | 配布プロンプトの特定の一文をマーカーにした存在・不在・回数検証 | ファイルを削除。knowledge解決は `knowledge`、facet合成は `dynamic-facet-composer`、実行への受け渡しは `engine-parallel` 等で検証 |
| `development-loop-routing` / `fix-replan-routing` | facet名・指示文・旧stepの不在を固定 | WorkflowEngineの完了・再計画・中断・ユーザー入力、レポート保持の実行テスト |
| `fix-verifier-routing-contract` | 自然言語の優先条件、評価fixtureの本文、instruction内の単語の不在を固定 | 選択済み判定からの実行時遷移、判定への応答受け渡し。判定の意味品質は `eval:prompts:fix-verifier-state-routing` の責務 |
| `prepare-dynamic-facet-composition` | YAMLの改行・配置、review policyの一文、旧語彙の不在を固定 | 動的facetの選択、CLI/importの副作用、caller review modeの展開、Phase 2のレポート参照。review modeは現行の実資産を入力として照合し、説明文を複製しない |
| `fix-loop-convergence` / `fix-plan-impact-prompt` | 見出し・区切り文・影響経路の説明文を固定 | 実際のscenarioと展開済みinstructionの挿入順、評価意図・正解の漏洩防止 |
| `postExecution` | エラー表示の定型接頭辞・説明文を固定 | `taskFailed` / `prFailed`、後続処理の停止、下位からの原因情報、機密情報の非露出 |
| `formalSpecVerifier` | TLCの対処説明を文単位で固定 | timeout、エラー状態、診断保持、出力上限、capture limit通知 |
| `report-phase-retry` / `report-reference` / `escape` / `it-report-inheritance-task-resume` | report指示・見出し・欠落案内の表現を固定 | 再試行、セッション、注入レコード、`scope: missing`、継承診断、未展開プレースホルダーの除去 |
| `interactive-summary` / `it-live-intervention-engine` / `companion-review.e2e` / `task` | 自然言語の方針が含まれるだけで挙動の保証とする | モード別出力、構造化結果、介入の配送状態、Companionの実行回数・指摘内容、タスク参照パス |
| `npmTestEntrypoint` | 実行方法の案内段落を全文固定 | shard並行起動・待機・終了コード。案内出力の有無は既存テストを維持 |
| `dependency-versions` | SDK・推移依存・修正済みリリース番号とpackage.jsonの丸写しを削除。正常な更新まで失敗させる完全一致は脆弱性検出にならない | registry integrity、宣言した最低Nodeとruntime依存のengine互換性、traced-configのpublic import。manifest/lockは変更しない |
| `policy-persona` | personaだけを入力して「agentより優先」と称する重複、display nameの重複、legacy instruction拒否の重複を削除 | persona未指定・inline・ファイル・並列、display name、専用 `instruction-template-removal` のschema pathとnormalize拒否 |
| `commands-run` / `commands-watch` | オプション説明文を全文固定 | `--ignore-exceed`登録、run/watchへの値の伝播 |
| `session-compaction` / `otelFoundation` / `deepseek-harness-provider` | 警告の説明文を全文固定 | fresh sessionへの切替、秘匿化metadata、shutdown継続、未対応オプションの識別 |
| `web-ui.integration` | HTMLタグ順・class・旧要素の不在・ボタン文言・JavaScript内部ソースを固定 | HTTPでshellとassetsを配信、JSが参照するDOM ID、アクセシビリティ属性、content-type。UI操作はDOM専用テストで検証 |

34テストファイルを整理し、テスト宣言は30個減少した（`it.each`等の展開前）。削除したファイルの明示分類も除去した。単純にテスト全体をskipした箇所はない。

## 残す文字列テストの具体例

- `provider-options-resolution`: 設定キーと設定由来の追跡。長い文字列でも自然言語のコピーではない。
- `policy-persona` の残したfixtureテスト / `knowledge` / `facet-includes-integration`: テストが作成した専用fixtureの読み取り・合成。ユーザーの内容を壊さない契約である。
- `companion-prompt-loop`: JSON evidenceのラベル・値、引用符や改行のエスケープ。
- `routing-model-input` / `escape` / `token-usage-csv`: 入力の正規化や符号化。出力バイト列に意味がある。
- `workflow-inspect` / `workflow-doctor`: 診断対象のキー・リソース・由来やCLI表示。削除したコピー検証とは区別する。汎用Errorだけを返す境界の原因識別を無差別に `toThrow()` に弱めない。
- `eval/fixtures`: レビュアーが不適切なテストを検出できるかを測る課題も含まれる。評価対象として意図的に置かれた悪い例まで製品テストと同様に掃除しない。

## 反証検証

製品ファイルへ一時変更を加え、対象テストを実行後に復元した。

| 一時変更 | 期待・結果 |
| --- | --- |
| 日英のタスク作成ラベルと日本語の省略案内を言い換え | 対象6テスト成功 |
| 翻訳が常に既定言語を参照するように破壊 | 言語切替テストが失敗 |
| 参照内容の文字数切り詰めを無効化 | `SOURCE_TAIL`の漏出を検出して失敗 |

この検証は代表境界に対するもので、残った全assertionの十分性や実モデルの判断品質を証明するものではない。抽出候補には必要な診断・変換・プロトコル検証も含まれる。例えば `structured-output-schema-validator` はschemaの拒否原因と対象パスを区別するため、エラー文字列の検証を維持した。削除・変更した契約について、機能の破壊を検出する証拠と、表現変更で壊れない証拠を確認した。
