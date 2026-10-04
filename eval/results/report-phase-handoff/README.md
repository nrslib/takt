# 実装レポートの入力引き継ぎ比較

修正前 `24b6990a4767602e8ec52fce7e1f6e56d0e4982a` と、既存修正候補
`9fc210c264f75bf2d29977e72e7a675ec9eaf1f1` を promptfoo で比較する。
候補は今回の RED 観測より前に作成された実装であり、観測後に新しく作った修正ではない。
既存の `implementation-report-source-agnostic/` の結果は変更しない。

v1/v2 は、事後の採点訂正まで含めた探索的結果である。独立レビューで、B の
`idless-source` 採点器に照合対象のレポート本文が渡っていないことと、対象プロンプトの
作業ディレクトリに `before` / `candidate` の比較ラベルが露出していることが判明した。
このため、以下の集計を確定した改善測定として使わない。元の入力・harness・生応答・
採点・hash をそのまま保存し、照合文脈と中立的な作業ディレクトリを用いる v3 で再測定する予定である。

公開する代表 P1 応答の2件には、元の実行環境の絶対パスが含まれていた。元のバイト列は
Git の追跡対象外である `eval/.results/report-phase-handoff-20261003/raw-public-extract/` の
同名ファイルに保存し、以下の公開用コピーではリンク先だけを公開フィクスチャへ置換した。
公開用コピーのリンクは閲覧用であり、実行時にモデルが参照した作業ディレクトリではない。
v1 集計と P1 trace の `response` / `responseHash` は元の生応答の SHA-256 を指す。
公開用コピーの SHA-256 とは区別し、v1/v2 の採点・集計・入力 hash は変更していない。

| 代表 P1 応答 | 生応答 SHA-256（v1/trace） | 公開用コピー SHA-256 |
|---|---|---|
| [RED](red/observed-label-control.phase1.output.md) | `f93639d64bf35e77e1f073d0e3ccef4c7564751706a5e064e2e57a636bfa0c2d` | `2e132bda701f0c9e92a3006675d93b1cdc241ac8a4e70b56a0c41c87d75eebb1` |
| [GREEN](green/observed-label-control.phase1.output.md) | `cfeeb539e89bfc2736313ffa2b851c02fc27f544dc157f639b738e553f5f25be` | `74545b83557ee15bcc218d89bd9299b3898ff8a6813c6b2afc47557d30c7fb71` |

## 先に固定した問題と合否条件

| ケース | 入力経路 | 必須の観測結果 |
|---|---|---|
| A: `revised-export` | 上流会話の Plan ID、通常の追加入力、実装 step へ dispatch された live 指示 | EXPORT-01 の意味を平文出力からマスクへ置換し、ID と Plan 由来・具体観測を保持して Verified。撤回された NOTICE-02 を必須の未完了作業へ復活させない |
| B: `rule-source-status` | workflow-wide rule が注入した任意名 `delivery-obligations.md`、ID なし3行 | 実在する行と出典を保持し、ID・別台帳を要求しない。実際の version 0 / 期待17 の失敗は Incomplete、credential が唯一の阻害である endpoint は Environment-limited、原因不明の timestamp 未実行は Incomplete |
| C: `observed-label-control` | 完成済み小関数を実 Phase 1 が読み、build/test を実行した最終応答から実 Phase 2 を生成 | LABEL-01/02 の Plan 由来・意味を保持し、実装位置・適切な test 位置・具体観測・実コマンド成功とともに両行 Verified。REQ/SCOPE、非該当の影響経路、別台帳を追加の完了義務にしない |

A/B は固定された Phase 1 要約を使う入力引き継ぎの隔離実験である。A/B の
実装位置・コマンド・観測値は合成した入力であり、対象モデルにコードを実行させた
結果とは主張しない。C は実際のコード確認・コマンド実行・Phase 1 最終応答を使う。
P1 の追加準備文と上流 snapshot 保持の効果を個別に切り分けた実験ではない。

正しい観測が揃う A/C に Verified を要求するため、すべて Incomplete と書くだけでは
通らない。API/provider エラー、空出力、実行条件監査失敗、grader エラーは
infrastructure failure とし、意味上の RED に数えない。

## 実行条件と凍結

ケース入力と rubric は RED 起動前に固定した。対象・grader はいずれも
`gpt-6-sol` / `high`、日英テンプレート各3ケースを各3反復する。各 revision は18件の
報告ケースで、C の P1 を含めた対象モデルの呼び出しは24回、意味採点は30回である。
生成 cache 無効、promptfoo の同時実行数1。
対象と grader の実 turn context から model、effort、read-only、approval never を監査する。
新しい SDK thread で P1/P2 を実行し、network・Web を無効、repo/user skills 継承を無効にした。

- cases SHA-256: `5c1d7fe1d6f150b2cb9c55441f1eacfa323d5f164d5bf21952c6e5650d585885`
- fixture SHA-256: `1c24958dd8e7466c77329985d39a617b02f7449ec830525b233be5ae381d85e5`

両 revision を `git archive` で隔離してビルドした。`runner.js` の `runAgent` 境界を
置き換え、実 WorkflowEngine、InstructionBuilder、ReportInstructionBuilder が生成した
user instruction を capture した。persona 本文を前置する一方、実 AgentRunner の
`buildWrappedSystemPrompt` が加える workflow・現在 step・process safety の system
wrapper は含まない。したがって、本番 provider と system wrapper 全体を通した測定ではない。
旧版に渡す payload を独自に削らない。
live 指示は上流 step 完了後に発行し、実装 P1 への提示と実際の `onDispatch` による
配送確定を検査する。C では実モデル P1 の最終応答を同じ revision の engine に渡して
P2 入力を組み立てる。採点 rubric は対象プロンプトへ混ぜない。

本番 payload の `allowedTools=[]` と新規 P2 を capture で検査する。SDK の read-only
自体は読み取りや shell を許すため、P2 のツール禁止はプロンプトと実イベントの検査に
よる評価境界である。P2 が実際にツールを使えば不合格とし、grader のツール使用とは
分ける。C は P1 の実コマンド成功、ソース・テスト確認、具体観測も決定論 assertion で
検査する。

日英はテンプレートの比較である。英語テンプレートでも本文が日本語になる応答があり、
完全に英語で回答する品質を測ったとは主張しない。AGENTS の継承無効は指定していない。

## 探索的な実測結果 v1

v1 の機械集計は **旧版0/18、候補13/18**、両版とも infrastructure failure は0件。
RED/GREEN とも grader は30回実行し、終了コードは1だった。
[v1 の全件集計](v1-summary.json) は個別合否・全P1/P2 artifact hash を保持する。
grader の全ての生理由は元JSONに保存し、公開集計に元JSONのhashも残す。
理由の正しさは別途照合しており、v1 の合否を書き換えていない。

| v1 metric | 旧版 | 候補 |
|---|---:|---:|
| execution-boundary | 18/18 | 18/18 |
| current-obligations | 0/6 | 6/6 |
| idless-source | 0/6 | 6/6 |
| state-priority | 1/6 | 5/6 |
| observed-evidence | 0/6 | 2/6 |
| precision-control | 2/6 | 6/6 |

旧版の18件には、A の現行要求・ID欠落、B の出典欠落、C の Plan由来・契約行・実装位置の
いずれかの本来必須情報の欠落があった。代表の A は、マスク出力と通知撤回の証拠が
与えられているのに、元の平文出力と毎回通知を未達作業へ復活させた。B は任意名レポートの
出典を失い、正式IDや別の計画照合が必要だとした。C の1反復目は両行を Verified とし、
実コマンド・観測を保持できた一方、Plan 由来を「新規発見」に変えた。C の別の反復では
契約表が空になり、または実 P1 最終応答から実装行番号が落ちた。

状態分類・証拠収集自体が旧版でも成功する例はある。たとえば B 日本語1反復目は
Incomplete / Environment-limited / Incomplete を正しく区別し、C 日本語1反復目は
コード確認・build/test・具体観測と Verified 判定に成功している。これらまで一括して
新しい候補だけの改善とは主張しない。代表応答は各 `red/`・`green/` のケース名にある。

候補で機械不合格になった5件は、B 日本語1反復目と C 日本語2・3反復目、英語1・3反復目。
出力契約と実 P1 記録を照合した結果、B は未確認範囲欄への証拠の重複要求、C は許容される
関数宣言の行番号1を拒否すること、必須でない正確なtest行番号の要求、grader に実 P1
応答・receiptを渡していないことによる証拠否定であった。元の理由に含まれるこれらの
過剰な要求を、本番プロンプトの改善根拠として採用しない。

実イベント監査では、v1 RED のgrader30件はツール使用0。一方、v1候補のgrader
7（C日本語1反復目）、9（C日本語3反復目）、17（C英語2反復目）は合計30回ツールを使った。
7/17はfixtureや公開代表応答、実P1応答・traceを探索して文脈を補い、9は空のgrader作業
ディレクトリで証拠探索に失敗した。したがって「P1証拠をgraderへ未提示」はプロンプト上の
不足であり、一部graderはツールで補完できた。この文脈探索の差もv1採点の制約である。
いずれも対象P2のツール使用とは別で、対象P2は全36件ツール使用0だった。

## 採点訂正 v2

v2 は **v1 応答を見た後の採点訂正** であり、対象生成前に固定した基準とは主張しない。
v1 の cases・rubric・harness・応答・集計はそのまま保存した。B の state-priority と
C の observed-evidence だけを訂正し、両版の同じ保存応答を再採点する。対象モデルの
追加生成は0回で、他の指標は v1 を継承する。

B の状態優先順位・観測値・コマンド・出典・不確実性の必須基準は変更していない。
[日本語の出力契約](../../../builtins/ja/facets/output-contracts/implementation-report.md)と
[英語の出力契約](../../../builtins/en/facets/output-contracts/implementation-report.md)は
Evidence欄でコマンドと位置を要求し、Quality Gatesでも実行情報を保持する。Unverified Scopeは
gapの理由・代替検証・残リスクを要求し、同じコマンド・位置の再掲を指定しない。
v2 は報告全体で証拠を保持した上で、未確認範囲欄の本来のgap情報を要求する。

C は immutable fixture の関数宣言が1行目、処理が2行目なので、どちらも実装位置として
許容する。testは適切なファイルpathで足り、exact lineを追加の義務にしない。graderへだけ
実 P1 最終応答・上流計画・source/test fixture・必要な成功receiptを参考文脈として渡す。
参考文脈を使って P1/P2 の欠落を埋めて合格にすることは禁止した。P1が必要な証拠を落とし、
P2が推測で補った場合も不合格である。

- v2 protocol SHA-256: `a9acee8f4905c0f5bb1ef523d262e635d724fd179807d29ee822f644cf623168`
- 共通 model/permissions/languages/repeats SHA-256: `f8060c7c0387b74f05a284bfcacece9fd50176e270286d9b78bf45fe10ac547b`

v2 は **旧版0/18、候補18/18**、両版とも infrastructure failure は0件。
24回の grader 呼び出しだけを追加し、終了コードは0だった。
[v2 の全件集計](v2-summary.json) に全36件の元応答hashと、再採点した24項目の
rubric/context hash・生理由を保存する。全P1/P2 artifact hashはv1集計に対応付ける。
対象の応答は1件も追加生成・変更していない。
v2のgrader全24件は実イベントでもツール使用0。v2に継承するv1の他metricのgraderも
全てツール使用0であり、上記の探索差は再採点したC observed-evidenceに限定される。

| v2 metric | 旧版 | 候補 |
|---|---:|---:|
| execution-boundary（v1継承） | 18/18 | 18/18 |
| current-obligations（v1継承） | 0/6 | 6/6 |
| idless-source（v1継承） | 0/6 | 6/6 |
| state-priority（再採点） | 1/6 | 6/6 |
| observed-evidence（再採点） | 0/6 | 6/6 |
| precision-control（v1継承） | 2/6 | 6/6 |

訂正した grader も本来の旧版の欠落を拒否している。C 日本語1反復目の理由は
「両IDを上流計画で定義された契約ではなく『新規発見』としており、必須のPlan由来を
保持していません」。同3反復目は「両契約に必須の実装箇所の行番号がありません。
Phase 1の最終回答にも行番号がなく、引き継ぎ要件を満たしません」とした。
候補C 日本語2反復目は、Plan由来・意味・位置・具体観測・成功結果が報告に揃い、
実 P1 応答と実行記録にも一致することを合格理由とした。

この round の追加作業は評価経路・採点文の訂正・監査・記録であり、本番プロンプトや
引き継ぎ実装は変更していない。保存応答では既存候補 `9fc210c` に義務変更・撤回、出典、
正常証拠の対応を保持する例が見られたが、独立レビューで判明した評価設計の不備により、
この集計から確定した改善を主張しない。P1準備文とsnapshot保持の個別効果も未分離。

## 独立レビューで判明した測定上の制約

B の `idless-source` rubric は「3つの実際の義務」を求めるだけで、実際の義務本文を
列挙せず、grader にも元の `reportContent` を渡していなかった。候補の保存応答6件には
正しい項目と出典位置があるが、採点器が入力との意味・位置の一致を検証できる構成ではない。
v2 はこの指標を v1 から継承しているため、事後訂正でもこの不備は解消していない。

対象に提示した作業ディレクトリは revision ごとに異なり、プロンプト本文に
`before` / `candidate` が含まれていた。比較ラベルから候補への期待をモデルが読み取る
余地があり、対応する両 revision に同じ中立的なパスを提示した比較が必要である。

実行境界の決定論判定にも、コマンド文字列の部分一致、ファイル名だけの確認、成功した
全コマンドの stdout から観測を探すという制約がある。保存済み P1 receipt では本当に
build/test が成功し、本文を確認しているため、この指摘自体が実行記録を覆すものではない。
ただし、将来の判定では実コマンド・本文確認・対象テストの成功 receipt と観測を結び付ける必要がある。

v3 はこれらの評価経路を修正し、必要な実入力を grader 専用の照合文脈として渡して、
旧版の RED から再測定する予定である。v1/v2 の結果を上書きせず、別の結果として記録する。

## 再現と監査

以下は探索的な v1/v2 の再現手順であり、確定した改善を検証する手順としては扱わない。

```bash
npm run build
node --test eval/asserts/report-phase-handoff.test.mjs \
  eval/asserts/report-phase-handoff-regrade.test.mjs
node eval/scripts/report-phase-handoff-eval.mjs freeze \
  24b6990a4767602e8ec52fce7e1f6e56d0e4982a \
  9fc210c264f75bf2d29977e72e7a675ec9eaf1f1 \
  eval/.results/report-phase-handoff-rerun
node eval/scripts/report-phase-handoff-eval.mjs red eval/.results/report-phase-handoff-rerun
node eval/scripts/report-phase-handoff-eval.mjs green eval/.results/report-phase-handoff-rerun
```

同じ認証済み Codex SDK の実モデル呼び出しが必要である。RED は全18件の応答・採点を
完了し、infrastructure failure なしで意味上の失敗を観測してから GREEN を開始する。
RED の終了コード1は意味上の不合格、2は infrastructure failure を表す。

今回の完全な promptfoo JSON、全 prompt、個別実応答、receipt と trace、隔離した両版は
`eval/.results/report-phase-handoff-20261003/` に保持する。生の内部 session イベントは
ローカルの Codex session ログで監査し、公開資産に session ID や認証値を含めない。
実行ログは `/private/tmp/report-phase-handoff-red-20261003.log`。
GREEN は `/private/tmp/report-phase-handoff-green-20261003.log`、v2 は
`/private/tmp/report-phase-handoff-regrade-v2-20261003.log`。

v2 は保存済み v1 の全36件の P2、および C の実 P1 の prompt/output/trace hash を監査して
設定を固定する。同じ対象応答を使い、同じ grader・effort・権限・cache・同時実行数で
B/C各12項目、合計24項目を採点し直す。

```bash
node eval/scripts/report-phase-handoff-regrade.mjs prepare \
  eval/.results/report-phase-handoff-rerun \
  eval/.results/report-phase-handoff-rerun/regrade-v2
node eval/scripts/report-phase-handoff-regrade.mjs run \
  eval/.results/report-phase-handoff-rerun/regrade-v2
```

代表 C の公開P1 traceはコード・test確認とbuild/test receiptの抜粋で、元traceのhashと
全コマンド数を残した。完全なtrace・JSON・全プロンプトはローカルに保持する。
新規 thread API の使い方は [公式 Codex SDK 説明](https://learn.chatgpt.com/docs/codex-sdk)に
対応する。実際の model・effort・権限・新規 thread は今回の実行記録でも監査した。

## 決定論検証

追加・既存の引き継ぎ評価テスト11件、既存eval契約テスト44件が成功した。
`npm run build`、`npm run lint`、`npm run test:type-contracts`、`npm run test:types`、
`git diff --check`も成功した。公開集計の全36件のP1/P2 artifact hash、代表の生応答と
receipt元hash、v1/v2設定・harnessの凍結hash一致を別途照合した。
これらの決定論テストは実モデルの意味上の合否とは別の検証である。

残る具体的な問題として、候補 B 英語2反復目の timestamp 実装位置は
`not implemented（実装箇所は未確認）` と記載された。入力では実装状態が不明であり、
未実装の断定は支持されない。出力書式が `file:line or not implemented` だけを示し、
「不明」を明示していないことは誘因の可能性があるが、この比較では独立に検証していない。
元のrubricはこの表現を必須採点していないため後から不合格基準を足さず、残リスクとして記録する。

この測定は3つの固定ケースと1種類の model/effort に限る。他モデルや実装一般への
全面的改善、P1 の追加準備文だけの独立効果、SDK でのツール完全無効化は示さない。
