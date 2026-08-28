# Fix-plan impact closure eval

## 目的

PR #1513 の長時間実行では、修正後に `fix-verifier` が計画に含まれない実在経路を検出し、`plan_invalid` で `fix-plan` へ3回戻った。評価対象は、採用済みの問題について独立して観測できる経路を実装前に分離できるかである。

## ケース設計

| ケース | 役割 | 候補へ見せない評価情報 |
|--------|------|--------------------------|
| primary | 部分設定が既定sectionを消す実在のloader欠陥から、3つの結果へ分かれる経路 | 必須の3経路と各検証条件 |
| held-out | 入力読込・変換・順序・永続化へ分かれる別構造 | 必須の4観測と過剰範囲の禁止条件 |

両fixtureのディレクトリ名とsnapshot名は中立名にする。候補へ渡す裁定には、実在する欠陥と受入条件だけを記載し、suite名、rubricだけが要求する具体値、採点用の禁止条件は含めない。

## RED / GREEN

- RED: production facet変更前の生成promptでprimaryを実行する。
- GREEN: 最小の一般則と出力構造を追加した生成promptでprimaryを再実行する。
- held-out: production変更後だけ別構造を実行し、primary固有の語彙へ依存していないことを確認する。
- 回帰: 既存のfix-plan Promptfoo suiteを同じ生成経路で実行する。

| 段階 | suite | 結果ID | 結果 | 確認内容 |
|------|-------|--------|------|----------|
| RED | `fix-plan-impact-closure-primary` | `eval-xbg-2026-08-28T18:19:23` | FAIL（score 0.3） | loaderの原因と修正方針は特定したが、3経路の具体的な入力、変更前後の結果、失敗する検証が不足 |
| GREEN | `fix-plan-impact-closure-primary` | `eval-JTt-2026-08-28T18:27:16` | PASS（score 1） | 同じ欠陥とrubricで、3経路すべてに入口からの接続、具体的な変更前後結果、回帰保持を記録 |
| held-out | `fix-plan-impact-closure-heldout` | `eval-QOY-2026-08-28T18:35:34` | PASS（score 1） | 異なる4経路を同じ公開入口から確認し、設定差分と実ファイル書込みを分離して検証 |
| 回帰 | `fix-plan-boundary-preflight` | `eval-hQ2-2026-08-28T18:44:33` | PASS | 保存境界に合わない候補を退け、実際の永続化経路を事前検証 |
| 回帰 | `fix-plan-cause-check` | `eval-rwp-2026-08-28T18:46:35` | PASS（9/9） | provider matrix全体で、未確認原因の断定を避け、確認できた原因へ修正範囲を限定 |

## 経路別証拠

GREEN候補（`eval-JTt-2026-08-28T18:27:16`）が記録したprimaryの経路は次のとおり。現在のfixtureで部分`source`が`TypeError`になることは契約テストでも観測する。

| 経路 | 入口から結果 | 成立入力と期待結果 | 1条件を変える反例と期待結果 | 観測結果 |
|------|--------------|--------------------|--------------------------------|----------|
| selection | `buildExecutionPlan` → `loadDefinition` → `selectEntries` → `selection` | selection-only source、tags=`keep`、entry=`e1` → IDs=`e1`、role=`auditor`、指定instruction | sourceを省略 → role=`reviewer`、既定instruction。他のcycle/monitorは同じ | 候補が変更前後値と修正前の`findCycle`失敗を記録し、grader PASS |
| cycle | `buildExecutionPlan` → `loadDefinition` → `findCycle` → `cycle` | workflow-only sourceの`start → finish → start` → 同じcycle配列 | sourceを省略 → `root → child → root`。selection/monitorは同じ | 候補が両cycle値と修正前の`selectEntries`失敗を記録し、grader PASS |
| monitor | `buildExecutionPlan` → `loadDefinition` → `evaluateMonitor` → `monitor` | monitor-only sourceのlimit=`1`、count=`1` → `stop`、`Review pass 1.` | sourceを省略 → `continue`、`Inspect pass 1.`。selection/cycleは同じ | 候補がdecision・展開済みinstructionの変更前後値を記録し、grader PASS |

held-out候補（`eval-QOY-2026-08-28T18:35:34`）とfixture契約テストが記録した経路は次のとおり。

| 経路 | 入口から結果 | 成立入力と期待結果 | 1条件を変える反例と期待結果 | 観測結果 |
|------|--------------|--------------------|--------------------------------|----------|
| source | `buildArtifact` → `loadInput` → `document` / index file | `source.json` → `d-001`、`alpha`、`beta` | sourceだけを`alternate.json`へ変更 → `d-002`、`gamma` | 候補記録と実ファイルを含む契約テストが一致し、grader PASS |
| render | `buildArtifact` → `renderDocument` → `document.label` | `document:{document_id}` → `document:d-001` | label templateだけを`note:{document_id}`へ変更 → `note:d-001` | labelだけが変わりcontent・sectionsは同じことを契約テストで観測 |
| sort | `buildArtifact` → sections sort → `sections` | details order=`1`、summary order=`2` → `details, summary` | orderだけを入替え → `summary, details` | documentは同じで順序だけが変わることを契約テストで観測 |
| write | `buildArtifact` → `writeIndex` → `indexFile` / file content | `output/index.md`へ`d-001`本文を書込む | indexPathだけを`output/alternate.md`へ変更 → 同じ本文を別ファイルへ書込む | 戻り値と両実ファイル内容を契約テストで観測し、grader PASS |

いずれもcache無効、repeat 1で実行した。primaryとheld-outは`gpt-5.6-luna`のreasoning effort max、boundary-preflightはsuite既定のCodex provider、cause-checkはsuite既定のprovider matrixを使用した。生成promptは15,894文字（primary）と15,322文字（held-out）。漏洩テストは、生成promptにsuite ID `fix-plan-impact-closure`、旧ケース名`static-path-audit`、旧probeラベルがないことと、productionの4 facetにfixture名、PATH ID、対象関数名がないことを確認する。候補へ正当に渡す裁定内容や作業ディレクトリまで非開示とは主張しない。

`fix-plan-bounded-proof` は関連候補として確認したが、production facet変更前の同一条件でも Luna (`eval-AHB-2026-08-28T17:11:45`) と Sol (`eval-aKO-2026-08-28T17:30:09`) がともにFAILしたため、今回変更の回帰判定には使用しない。これを通すためのケース固有プロンプトは追加しない。
