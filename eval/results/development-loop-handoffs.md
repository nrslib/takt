# 開発ループの引き継ぎ評価

2026-09-11に、基準コミット `fef072115677cc1b99e6416b05944ebdf8af0c53` と修正後のbuiltinsを比較した。元run全体の再実行ではなく、実ログを要約した資料と新規の別領域ケースによる固定入力評価である。

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

修正前後のinstructionと保存済み評価入力を別途比較した。対象6系統の合成instructionはレビュー修正前と全文一致し、対象外8系統は基準SHAのinstructionに戻った。主要比較と自己ラベル対照の60プロンプト・判定ルール、および引き継ぎ判断の12プロンプトは保存manifestと一致した。全216応答を現在の採点関数で確認し、最新採点との一致を確認した。外部モデルは再実行していない。

- RED: `/private/tmp/takt-loop-review-red-routing.log`、`/private/tmp/takt-loop-review-red-eval.log`
- GREEN: `/private/tmp/takt-loop-review-green-routing.log`、`/private/tmp/takt-loop-review-green-eval-after-build.log`
- 同一性監査: `.tmp/development-loop-review-fixes/audit.mjs` を実行した `audit.json`、`instructions-before.json`、`instructions-after.json`。再実行コマンドは `node .tmp/development-loop-review-fixes/audit.mjs`
- 修正後のbuild、lint、分類契約20件、ローダー144件、既存eval契約38件も成功

最終契約テストの初回はbuildと並行してdistの再生成に競合し、2件で `ERR_MODULE_NOT_FOUND` となった。ログ `/private/tmp/takt-loop-review-green-eval-final.log` を保持し、build完了後に逐次再実行して上記16件の成功を確認した。

未確認の3懸念は変更範囲を広げず、次の限界として記録する。調査stepは `edit` と明示されたpolicy/knowledgeを持つが、`enable-skills` と動的facet選択は追加していない。スキルや動的な専門知識を必要とする実調査の品質は今回未測定である。loop monitorはReport Directoryの証拠を比較する指示を持ち、fix-planも `fix-investigation.md` の結果を消費するが、monitor本文は調査レポート名を明示していない。調査ループにおける監視モデルの実際の読み取りと収束判断も未測定であり、今回の保存済み証跡から実害は確認できなかった。
