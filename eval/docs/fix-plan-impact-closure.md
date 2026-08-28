# Fix-plan impact closure eval

## 目的

PR #1513 の長時間実行では、修正後に `fix-verifier` が計画に含まれない実在経路を検出し、`plan_invalid` で `fix-plan` へ3回戻った。評価対象は、採用済みの問題について独立して観測できる経路を実装前に分離できるかである。

## ケース設計

| ケース | 役割 | 候補へ見せない評価情報 |
|--------|------|--------------------------|
| primary | 設定から複数の結果へ分かれる経路 | 必須の3経路と各検証条件 |
| held-out | 入力読込・変換・順序・永続化へ分かれる別構造 | 必須の4観測と過剰範囲の禁止条件 |

両fixtureのディレクトリ名とsnapshot名は中立名にする。候補へ渡す依頼と裁定には、rubricの経路一覧やsuite名を含めない。

## RED / GREEN

- RED: production facet変更前の生成promptでprimaryを実行する。
- GREEN: 最小の一般則と出力構造を追加した生成promptでprimaryを再実行する。
- held-out: production変更後だけ別構造を実行し、primary固有の語彙へ依存していないことを確認する。
- 回帰: 既存のfix-plan Promptfoo suiteを同じ生成経路で実行する。

| 段階 | suite | 結果ID | 結果 | 確認内容 |
|------|-------|--------|------|----------|
| RED | `fix-plan-impact-closure-primary` | `eval-J1J-2026-08-28T14:35:11` | FAIL（score 0.5） | 3経路は発見したが、selectionとcycleの入力・設定差分を同じ入口から観測する検証が不足 |
| GREEN | `fix-plan-impact-closure-primary` | `eval-wsW-2026-08-28T14:43:05` | PASS（score 1） | 3経路すべてに入口から結果までの接続、成立例、因果関係のある反例を記録 |
| held-out | `fix-plan-impact-closure-heldout` | `eval-N1o-2026-08-28T14:59:20` | PASS（score 1） | 異なる4経路を同じ公開入口から確認し、設定差分と実ファイル書込みを分離して検証 |
| 回帰 | `fix-plan-boundary-preflight` | `eval-13N-2026-08-28T15:08:34` | PASS（score 1） | 保存境界に合わない候補を退け、実際の永続化経路を事前検証 |
| 回帰 | `fix-plan-cause-check` | `eval-uG4-2026-08-28T15:15:33` | PASS（score 1） | 並列失敗だけを原因とせず、記録済みの製品原因へ修正範囲を限定 |

いずれもcache無効、repeat 1で実行した。primary、held-out、cause-checkは`gpt-5.6-luna`のreasoning effort max、boundary-preflightはsuite既定のCodex providerを使用した。生成promptは15,241文字（primary）と15,235文字（held-out）で、suite名、fixtureの評価意図、rubricの必須経路一覧を含まない。

`fix-plan-bounded-proof` は関連候補として確認したが、production facet変更前の同一条件でも Luna (`eval-AHB-2026-08-28T17:11:45`) と Sol (`eval-aKO-2026-08-28T17:30:09`) がともにFAILしたため、今回変更の回帰判定には使用しない。これを通すためのケース固有プロンプトは追加しない。
