# 開発ループの引き継ぎ評価

2026-09-11に、基準コミット `fef072115677cc1b99e6416b05944ebdf8af0c53` と最初の修正案を比較した。元run全体の再実行ではなく、実ログを要約した資料と新規の別領域ケースによる固定入力評価である。最初の比較、Lunaレビュー後の同一性確認、CodeRabbit対応後の最終版評価は別の記録として扱う。

## Phase 3の遷移

修正案の作成後、期待する `next` / `return` をモデル比較の実行前に固定した14ケースについて、日英の判定条件で評価した。基準SHAから旧定義を読み込み、全モデルの旧定義評価が終了してから、新定義の評価を開始した。各モデル・言語・版につき1試行である。

| モデル | 旧定義 | 新定義 | APIエラー |
|--------|--------|--------|-----------|
| Claude `claude-opus-5` | 12/28 | 28/28 | 0 |
| Codex `gpt-6-astra`, `xhigh` | 12/28 | 28/28 | 0 |
| Kimi Code `kimi-code/k3` | 12/28 | 28/28 | 0 |

3モデルとも内訳は同じだった。

| ケースの出自 | 旧定義 | 新定義 |
|--------------|--------|--------|
| 実ログ由来の要約3件 | 2/6 | 6/6 |
| 新規の別領域5件 | 0/10 | 10/10 |
| 対照6件 | 10/12 | 12/12 |

別領域はCSV取込の残実装、セッション失効後の検証残件、バイナリcodec・帳票PDF・通信パーサーの原因調査である。修正後は、有効な計画の残件を継続し、局所調査を全体再計画へ送らなかった。完了済みの作業、検証済みの変更不要ケース、真に不備のある計画、確定済みの修正計画、必要な外部操作の対照も確認した。

旧定義に局所調査と実装継続の経路がないことが主要なREDであり、すべてがモデル単体の誤判断を意味するわけではない。旧定義ですでに成功していたケースは回帰対照であり、新たな失敗再現として数えない。

実ログ由来の必須検証残件では、3モデルとも新旧で同じ `[IMPLEMENT:3]` を返した。しかし旧YAMLでは `return: need_replan`、新YAMLでは `next: implement` なので、実際の遷移はREDからGREENへ変わっている。局所調査では旧定義の `fix` または `need_replan` から、新定義の `investigate` へ変わった。

## 自己ラベルが事実と矛盾する対照

元runの修正計画と同じ「結果: タスク全体の再計画が必要」というラベルを付け、本文には局所的な原因調査が未実行であることと、要求・範囲を変える根拠がないことを記載した。主要14件を変更せず、別ファイルと別評価ディレクトリで実行した。

| モデル | 旧定義 | 新定義 |
|--------|--------|--------|
| Claude Opus 5 | 0/2 | 2/2 |
| Codex Astra xhigh | 0/2 | 2/2 |
| Kimi Code k3 | 0/2 | 2/2 |

全モデルの旧応答は `[FIX-PLAN:2]` で `need_replan`、新応答は同じタグで `investigate` だった。新Claudeの日本語応答には正しいタグの後に説明があった。本番のタグパーサーはこの形式も受理する。

## 採点の訂正と証跡

初回の評価スクリプトは1行タグを厳密照合し、説明付き応答を形式違反としていた。セルフレビューで本番 `detectCandidateIndex` が本文中の最後のタグを採用することを確認し、同関数と `semanticRuleCandidatesOf` を再利用する採点へ訂正した。ケース・期待遷移・モデル入力を変えず、保存済み応答をローカルで再採点した。

主要比較の合否件数は変わらない。自己ラベル対照では、Claude新日本語の初回形式違反が、実際には `investigate` へ遷移することを確認した。モデルの再実行による改善ではなく、評価側の本番パーサーとの不一致の修正である。タグが見つからない場合の後続AI judgeや構造化出力を含む全段階の自動復旧は、この評価では実行していない。

- 主要比較: `.tmp/development-loop-comparison/`
- 自己ラベル対照: `.tmp/development-loop-stale-label/`
- 各ディレクトリの `manifest.json`: 送信前に固定したプロンプト、期待値、旧定義SHA、ケースSHA256、モデル設定
- 各 `provider-revision-language-case.json`: 実応答、開始時刻、実行時間、初回採点。訂正後も保持
- 各 `scored-results.json`: 本番パーサーによる最新採点。`summary.json` はこの採点の集計

主要ケースのSHA256は `581cd17b56239c0bafc6e4439073df45a8d3ac2c65c1c3bc452111e785f02dde`。
再採点は `eval/asserts/completion-routing.mjs` の `scoreTransition` と `eval/scripts/development-loop-eval.mjs` の `runComparison` で行う。入力定義が同一なら通常の比較コマンドで元応答を再採点できる。後述のレビュー修正ではinstructionの配線位置が変わり、保存されたraw stepメタデータと現在のYAMLが異なるため、[README](../README.md#development-loop-handoffs) 末尾の保存済みmanifestを明示するコマンドを使う。元応答の存在を先に確認し、モデルを呼ばずに採点する。

## 実装instructionでの引き継ぎ判断

実ローダーで合成した実装instructionへ、3件の固定資料を与えた。画像出力を題材にした有効な成功証跡と未実行検証、結果に影響する変更で失効した証跡、文書公開を題材にした複数状態・時点・外部観測の縮小を扱う。次に実行する検証、引き継げる成功結果、保持する受入条件をJSONで回答させた。

| モデル | 旧: JSON形式と判断 | 新: JSON形式と判断 | 旧: 判断内容のみ | 新: 判断内容のみ |
|--------|-------------------|-------------------|------------------|------------------|
| Claude Opus 5 | 6/6 | 6/6 | 6/6 | 6/6 |
| Codex Astra xhigh | 6/6 | 6/6 | 6/6 | 6/6 |
| Kimi Code k3 | 3/6 | 5/6 | 6/6 | 6/6 |

Kimiの形式違反4件は、正しいJSONコードブロックの後に説明を付けた応答だった。候補定義にも1件残っている。初回採点を変更せず、単一JSONブロックを抽出して同じ期待値と比較する別の内容監査で、全36応答の判断内容一致を確認した。複数JSONブロックは曖昧として内容監査でも拒否する。

判断内容は旧定義でも成立しており、この小規模な評価は回帰確認に限る。証跡再利用や受入条件保持について、新たな行動上のREDや改善率を再現したとは扱わない。

証跡は `.tmp/development-handoff-comparison/`。`manifest.json`、個別の実応答と初回採点、`scored-results.json`、`content-audit.json` を保持している。内容監査は次のコマンドで再現でき、モデルを呼ばない。

```bash
node eval/scripts/development-handoff-eval.mjs --audit-content .tmp/development-handoff-comparison
```

## 検証と評価範囲

共通partial整理後、実ローダーで日英40 stepへの受入条件保持手順の注入を確認し、各stepに1回だけ入ることを確認した。build、lint、遷移テスト34件、ローダーテスト144件、既存のeval契約38件、新規eval契約7件が成功した。実装引き継ぎ前に完了していたfast unit 6,081件、light IT 2,460件、分類契約20件、E2E smoke 19成功・1skipの結果も保持している。

Phase 3では両言語の実判定条件を使用するが、固定レポートは両方とも日本語である。元runの入力全文・会話履歴・実行環境を再現した試験ではなく、一般的な誤り率や31 iterations・526分38秒からの時間削減量も測定していない。

引き継ぎ判断評価も、実行時のsystem prompt・policy・knowledge・quality gate・会話履歴をすべて含む試験ではない。実コマンド実行、生成コード、調査実験の正しさはこの評価では測定していない。

## 独立レビュー後の修正

Luna maxの独立レビューで、共通実装stepへの継続instructionの追加が、継続ルールのないsimple/mini系にも及ぶ問題と、補助評価2種がルール番号だけを採点する問題が見つかった。

継続instructionは `development-implement`、`development-implement-dynamic`、`development-implement-team` の呼び出し側だけで合成するようにした。日英のsimple/mini系4種を対象外対照に追加し、実ローダーで指示混入を検出した。修正前は48件中8件失敗、修正後は同じ48件が成功した。

補助評価 `completion-scope-routing` と `completion-scope-structured` の21ケースは、期待値を `expected_transition` として固定し、主要比較と共通の本番候補解決で実際の `next` / `return` を採点する。新旧の同番号が実装継続と全体再計画、局所調査と全体再計画をそれぞれ指す対照を、日英・2応答形式で追加した。修正前は15件中8件失敗、修正後は同じ15件が成功した。不正な構造化応答の対照を加えた最終契約テストも16件すべて成功した。これらはローカル回帰テストのRED→GREENであり、追加のモデル試行ではない。

このLuna対応時点で、修正前後のinstructionと保存済み評価入力を別途比較した。対象6系統の合成instructionはレビュー修正前と全文一致し、対象外8系統は基準SHAのinstructionに戻った。主要比較と自己ラベル対照の60プロンプト・判定ルール、および引き継ぎ判断の12プロンプトは保存manifestと一致した。全216応答を採点関数で確認し、最新採点との一致を確認した。この配線整理では外部モデルを再実行していない。後続のCodeRabbit対応では判定条件が変わるため、この72プロンプトの同一性を最終版の根拠として流用しない。

- RED: `/private/tmp/takt-loop-review-red-routing.log`、`/private/tmp/takt-loop-review-red-eval.log`
- GREEN: `/private/tmp/takt-loop-review-green-routing.log`、`/private/tmp/takt-loop-review-green-eval-after-build.log`
- 同一性監査: `.tmp/development-loop-review-fixes/audit.mjs` を実行した `audit.json`、`instructions-before.json`、`instructions-after.json`。再実行コマンドは `node .tmp/development-loop-review-fixes/audit.mjs`
- 修正後のbuild、lint、分類契約20件、ローダー144件、既存eval契約38件も成功

最終契約テストの初回はbuildと並行してdistの再生成に競合し、2件で `ERR_MODULE_NOT_FOUND` となった。ログ `/private/tmp/takt-loop-review-green-eval-final.log` を保持し、build完了後に逐次再実行して上記16件の成功を確認した。

未確認の3懸念は変更範囲を広げず、次の限界として記録する。調査stepは `edit` と明示されたpolicy/knowledgeを持つが、`enable-skills` と動的facet選択は追加していない。スキルや動的な専門知識を必要とする実調査の品質は今回未測定である。loop monitorはReport Directoryの証拠を比較する指示を持ち、fix-planも `fix-investigation.md` の結果を消費するが、monitor本文は調査レポート名を明示していない。調査ループにおける監視モデルの実際の読み取りと収束判断も未測定であり、今回の保存済み証跡から実害は確認できなかった。

## CodeRabbit対応

PR #1554の初回head `e0407b6a719faaff79dbb1cb605e6ce86b136f16` への5指摘を実コードで確認した。

1. 対話で回答を受ければ進められる場合をABORTから除外した。除外条件は、判定候補にユーザー入力の選択肢が存在する場合に限る。非対話モードでは外部回答待ちも停止対象に残す。
2. 再計画は、計画変更によりプロジェクト内で実行可能な作業が生じる場合に限定した。外部操作だけでしか進めない状態を除外する。継続も、外部操作や回答を待たず今実行できる次の作業を条件にした。
3. `eval/asserts/development-loop-eval.test.mjs` に `node:url` の `URL` importを追加した。`npm run lint` はsrcだけを対象とするため、evalファイルへ直接ESLintを実行し、修正前の `no-undef` 2件と修正後の成功を確認した。
4. 引き継ぎ判断のJSONはトップレベルを `run`、`carry`、`acceptance` の3キーに限定した。正しい配列に `executed: true` を足した応答を修正前に受理するREDを確認し、修正後は形式採点・内容監査とも拒否する。
5. 日英remediation全4種で、fix-planの `need_replan` とABORT、investigateのABORTをエンジンで実行した。実装3種では対話時の入力要求・回答後の再開と、非対話時の停止も実行した。

`RuleEvaluator` のsemantic条件は、Phase 3が選んだラベルとの一致で決まる。自然言語の条件をルール順に独立評価して先勝ちさせる動作ではないため、指摘1のfirst-matchという説明は採用せず、モデルに提示される候補条件の重なりとして修正した。エンジンの84件は条件修正前も成功しており、配線自体の新しい故障再現とは扱わない。

追加の固定対照3件は、同一の帳票出力先選択レポートを対話あり・なしで判定する2件と、回答だけでは解消しない外部の検証権限不足1件である。期待値は評価前に固定し、途中で変更していない。初回headでは全モデル6/6だった。

最初のCodeRabbit対応案は、ユーザー入力が「利用可能」であることを判定候補に十分限定せず、非対話の回答待ちを継続と誤判断する回帰を生んだ。ClaudeとCodexは各4/6、Kimiは取得済みの有効応答3/4だった。Kimiの1呼び出しを中断し、残り1件と既存15件の評価へ進む前に停止した。失敗版の34実応答と中断1記録は `.tmp/development-loop-cr-boundaries/` に保持し、中断をモデルの判断結果に数えない。`interruption.json` に停止理由を記録した。

この失敗を受け、継続を「外部操作や回答を待たず今実行可能」に限定し、ABORTには「判定候補に入力ルールがない外部回答待ち」を明示した。改訂版のmanifestは別ディレクトリに固定した。既存15件の基準版プロンプト・期待遷移・ルールが元の保存manifestと一致することを確認し、旧90応答は再取得せず保存証跡を使用する。追加3件の旧18応答も同様に、初回headの保存入力との一致を確認して引き継ぐ。

引き継ぎ判断のPhase 1 instructionはこの対応で変更していない。保存済み12プロンプトの一致と、トップレベルキーを厳密化した採点で全36応答の合否不変を確認した。厳密形式と判断は32/36、内容監査は36/36のままである。証跡は `.tmp/development-loop-cr-handoff-audit.json`。この再採点も新たなモデル試行ではない。

## CodeRabbit対応後の最終版評価

改訂した境界条件の18応答がすべて成功してから、同じ最終文言で既存15ケースの90応答を新たに取得した。最終候補は合計108応答すべてが固定期待値に一致した。

| モデル | 既存15件の基準版（保存証跡） | 既存15件の最終候補（新規取得） | 追加3境界の最終候補（新規取得） | 最終候補のAPIエラー |
|--------|----------------------------|------------------------------|--------------------------------|---------------------|
| Claude `claude-opus-5` | 12/30 | 30/30 | 6/6 | 0 |
| Codex `gpt-6-astra`, `xhigh` | 12/30 | 30/30 | 6/6 | 0 |
| Kimi Code `kimi-code/k3` | 12/30 | 30/30 | 6/6 | 0 |

既存15件は主要14件と自己ラベル対照1件の合計で、基準版は `fef072115677cc1b99e6416b05944ebdf8af0c53`。出自別の最終候補は、各モデルとも実ログ要約6/6、新規別領域10/10、対照14/14である。追加3境界の比較基準は初回PR head `e0407b6a719faaff79dbb1cb605e6ce86b136f16` で、旧版も6/6だった。追加境界については元のheadからの改善率を主張せず、不成功だった中間案の回帰を同一ケース・期待値で解消した記録とする。

最終監査は、36個のモデル入力と判定ルールが現行ソースに一致すること、ケースのSHA256・期待値が固定時から変わらないこと、全108応答のmanifestHashと採点が一致することを確認した。また、境界の最後の応答完了時刻が、既存15件の最初の呼び出し開始以前であることを確認した。

- 境界の最終候補: `.tmp/development-loop-cr-boundaries-v2/`。manifest SHA256: `d4e017ee52198f7fd54de75ee4ee145d397a7bad8186e39d9b254945970015ca`
- 既存15件の最終候補: `.tmp/development-loop-cr-final-candidate-v2/`。manifest SHA256: `ee25b6bd3d107734713f8e7757fa3d4a92d3b62bbf728efa7dc6ae0f24f2935d`
- 両ディレクトリの個別応答、`scored-results.json`、`summary.json` を保持
- 実行runner: `.tmp/development-loop-cr-eval.mjs`。`--prepare` で固定と旧入力一致を確認し、`--run-boundaries`、全18件成功後の `--run-final` の順に実行。初回案のrunnerは `development-loop-cr-eval-v1.mjs` に保持
- 最終監査: `node .tmp/development-loop-cr-final-audit.mjs`。結果は `.tmp/development-loop-cr-final-audit.json`
- モデルログ: `/private/tmp/takt-loop-cr-v2-boundary-models.log`、`/private/tmp/takt-loop-cr-v2-final-models.log`

CodeRabbit対応後はbuild、srcのlint、変更したeval全5ファイルへの直接ESLint、エンジン84件、eval契約18件、分類契約20件、既存eval契約38件、`git diff --check` が成功した。REDは `/private/tmp/takt-loop-cr-red-eslint.log` と `/private/tmp/takt-loop-cr-red-handoff.log`、最終の対応するGREENは `/private/tmp/takt-loop-cr-eval-eslint-final.log` と `/private/tmp/takt-loop-cr-v2-eval.log`。エンジン最終結果は `/private/tmp/takt-loop-cr-v2-engine.log`。

最終版も固定入力の単発評価であり、実コマンド行動や元run全体の収束時間は未測定という限界は変わらない。

## 構造化providerの入力要求候補

Lunaの限定レビューで、`completion-scope-structured.yaml` のprovider JSON Schemaが候補番号を最大5に制限し、対話時の入力要求候補6を拒否する欠陥が見つかった。既存契約は採点関数を直接呼び出しており、このprovider制約を検証していなかった。

契約ヘルパーに実configのJSON Schema検証を加えると、18件中、候補6を期待する1件が失敗した。同じテストを維持して上限を6に修正すると成功した。固定済みの入力要求ケースを読み込むadapterを構造化suiteのtestsへ接続し、日英の候補6受理、範囲外・非整数・余分なキーの拒否も確認した。非対話時の候補6は引き続き本番候補解決で拒否する。最終契約は19/19、変更evalファイルへの直接ESLintと `git diff --check` も成功した。

加えて、promptfooの公開 `loadApiProvider` から実 `openai:codex-sdk` providerをロードし、同configの `output_schema` を渡してCodex `gpt-6-astra` / `xhigh` を日英各1回呼び出した。入力はadapterで接続した既存の帳票出力先選択ケースで、期待遷移は送信前から固定した `next: implement` / `requires_user_input: true`。両応答ともschemaに適合する `step: 6` を返し、実際の遷移も一致した。旧上限5はこれらの応答を拒否する。CLIは空の一時作業ディレクトリで、read-only・承認never・スキル継承なし・ネットワークツール無効で実行した。保存されたSDK itemは両方とも `agent_message` のみだった。

- RED: `/private/tmp/takt-loop-schema-red.log`。GREEN: `/private/tmp/takt-loop-schema-green.log`。直接ESLint: `/private/tmp/takt-loop-schema-eslint.log`
- 実行runner: `.tmp/development-loop-structured-schema.mjs`。`--prepare` で入力・期待値・schema・provider設定・ソースSHA256を固定し、`--run` で実行する。全応答保存後の同コマンドは入力一致を確認して保存応答を再採点し、モデルを呼ばない
- 証跡: `.tmp/development-loop-structured-schema/manifest.json`、`codex-ja.json`、`codex-en.json`、`summary.json`、`schema-audit.json`。モデルログ: `/private/tmp/takt-loop-schema-models.log`
- manifest SHA256: `4fb18697ce7ce5b1ac21db576fdbb0ff89b8dd6cf2e826c32bb69eca0d45ce44`
- 既存タグ評価の再監査: `node .tmp/development-loop-cr-final-audit.mjs`。ログ `/private/tmp/takt-loop-schema-tag-audit.log` で36入力の不変と全108応答の採点一致を確認し、3モデルのタグ評価は再実行していない

この2応答は構造化provider経由の入力要求境界を確認する追加試行である。構造化suite全ケースや他モデルを再評価した結果とは扱わない。RED→GREENは同一のローカルschema契約で確認し、旧schemaによる外部モデル呼び出しは行っていない。
