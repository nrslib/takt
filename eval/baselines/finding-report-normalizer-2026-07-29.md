# Finding report normalizer baseline — 2026-07-29

## 対象契約

このbaselineは、自由記述のreview report 1件だけを
`RawFindingsOutputJsonSchema`へ変換する抽出専用契約を測る。promptには元task、
他report、repository contentを含めず、working directoryは空の一時directoryにする。
主張の真偽、重要度、既存findingとの意味上の関係はnormalizerに裁定させない。

providerのtool capabilityは同一ではない。Claude/OpenCodeには`allowedTools: []`を
要求するが、Codex CLIにはread-only sandbox内のshell capabilityが残る。したがって
これはCodexに対する物理的なno-tools保証ではなく、JSONL eventで観測した
`toolUseCount === 0`をcallごとの合格条件にするevalである。productionのno-tools要件を
この測定で満たしたとは扱わない。

抽出規則は次の境界を固定する。

- `rawExcerpt`はreport内の完全一致する連続部分文字列
- reportが明記しないfieldは`null`または空配列
- title、description、suggestionは同じexcerptからのみ抽出
- code、structure、absence targetはreportが明記したpath/scopeだけで構成
- evidenceはproofではなく、reportに明記された`file_quote`または
  `engine_proof` requestだけを構成
- 1 reportを1回の隔離model callで処理し、report間の混在を防ぐ

promptの正本は
`src/shared/prompts/finding-intake-extraction.ts`、case一覧と外部送信区分は
`eval/cases/finding-normalizer/extraction-catalog.json`に置く。生成済みpromptを
正本にはしない。

## 合格条件

各callは次をすべて満たした場合だけstrict PASSとする。

- provider実行完了
- stored invocation promptのSHA-256が現行rendered promptと一致
- `RawFindingsOutputJsonSchema`適合
- explicit claim recall 100%
- `rawExcerpt`の一意なsource binding 100%
- candidateのgold完全一致
- unexpected claim、excerpt外文字列、field補完が0
- goldの`null`と空配列を100%保持
- findingのreport内順序がgoldと完全一致
- cross-report mixing 0
- tool use 0

render-only時にも全goldを現行schemaで検証し、gold自身を採点器へ通してstrict
PASSすることを確認する。`--self-test`はschema-invalidな7種類のoutputをthrowせず
FAILにし、逆順outputをorder不一致でFAILにし、scorer自身の例外を
`errorKind: "scoring_error"`として保存できることを確認する。

## 旧promptの実測

測定したprompt templateのSHA-256は
`a3b25caddd72cbb6e1a1545781359eff6fb5c02a5511605c52c11f7dd0c65d2d`で、
当時のproduction prompt定数と一致していた。ledger lifecycle confirmationを抽出する
現行promptのSHA-256は
`0513c7536b96235e151c9d4478d568a54a58b877aeba0c915bbadae8df18b983`であり、
この版の外部model測定はまだ行っていない。以下の数値とartifactは旧hashの履歴で、
現行promptの結果として扱わない。

provider capacity errorはmodel outputが生成されていないため、model出力のFAILへ
数えない。provider attemptの未完了として別記し、fresh retryは別result setへ保存した。

| case | Luna | Terra |
|---|---:|---:|
| summary-only、初回3反復 | 完了2/2 PASS、capacity 1 | 3/3 PASS |
| summary-only、Luna fresh retry | 1/1 PASS | — |
| broad-target、6 report | 5/6 PASS | 6/6 PASS |
| 完了したmodel output合計 | 8/9 PASS | 9/9 PASS |

Lunaのbroad-target report 3はschema、claim recall、source binding、
non-fabrication、ambiguity、finding order、tool use 0をすべて満たしたが、reportに
明記された`authoritative_quote`の`evidenceRequest`を1件落とした。そのため
candidate exactは0でstrict FAILになった。`repository_query` requestは保持しており、
失敗原因はtyped evidence requestの部分欠落に限定される。

旧promptの結果artifact:

- `eval/.work/finding-report-normalizer/results/final-summary-luna-terra-r3-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/final-summary-luna-retry1-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/final-broad-luna-terra-20260729/summary.json`

### 未測定範囲と外部送信境界

現行promptは全providerで未測定である。Gemma4のschema不適合を含む旧artifactは、
現行promptの集計には加えない。

`pr-attachments-six-reviews`の6件は、localでprompt生成、schema検証、gold自己採点まで
完了した。ただしlocal review materialの外部model送信は承認されなかったため、
いずれのproviderにも新規送信していない。runnerはこのcaseを
`requires_explicit_approval`として扱い、実model callには明示承認後の
`--allow-external-review-data`を要求する。

## 旧promptのtuning履歴

旧promptではheading内の`Issue:`をdescriptionにも複製するTerraのずれを修正し、
Luna/Terraが合成caseを通過した。Gemma4はcandidate内へschemaに存在しない`code`
keyを置き、必須nullable field、`target`、`evidenceRequests`を欠落させた。

これらは現行promptの結果へ加算しない。旧artifactを現行scorerでscore-only実行すると、
内容metricが満点でも`promptArtifactMatchesCurrent: false`によりstrict FAILになる。

旧promptの結果artifact:

- `eval/.work/finding-report-normalizer/results/smoke-codex-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/tuned-summary-r3-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/broad-codex-20260729/summary.json`
- `eval/.work/finding-report-normalizer/results/smoke-gemma4-20260729/summary.json`

## 過去のfree-form実測との区別

`eval/.work/finding-normalizer-intake/`にある過去の5-model実測は、現在とは異なる
free-form intake contractである。旧出力は`candidates`配下にモデル生成の
title、summary、suggestion、certainty、disposition、severity、locationsを持ち、
現在のnullable `candidate`、typed target、evidence requestとは一致しない。

旧`five-models-r1`ではLuna、Terra、Gemma4、Sonnetが全7 claimを抽出し、指摘なし
report 3件も空のまま保持した。Haikuはturn capで一部未完了だった。旧Gemma4
3反復ではclaim単位の`rawExcerpt`完全一致が19/21だった。これらは旧契約に対する
抽出・自由生成の結果であり、現行契約のschema適合、null保持、typed evidence能力を
示さない。

参照artifact:

- `eval/.work/finding-normalizer-intake/results/five-models-r1/summary.json`
- `eval/.work/finding-normalizer-intake/results/gemma4-repeat3/summary.json`
- `eval/baselines/finding-normalizer-2026-07-28.md`

旧結果を現行promptの実測結果へ加算せず、モデル順位にも引き継がない。

## 判断

- 現行の合成fixtureに対するproduction normalizer第一候補はTerra。完了した
  model output 9/9がstrict PASS。
- Lunaは第二候補。summary-onlyの完了outputはfresh retryを含め3/3 PASSだが、
  broad-targetはtyped evidence requestの欠落により5/6。
- Lunaのcapacity error 1件はprovider未完了であり、model出力FAILには数えない。
- Gemma4はschema不適合を記録しているため候補外。
- local review materialを用いた実report評価は未承認・未実行。
- production/configにはopt-inの`intake_normalize`として統合済みである。現行promptの
  外部model測定は未実施であり、旧promptの結果を現行統合の実測値として扱わない。
