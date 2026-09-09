# 実装報告の引き継ぎ評価

- 日付: 2026-09-09
- 変更前: `2e1ef35ac31cf3938cb65bc8a777f2d86729c7a9`
- 対象: 日本語 `development-implement-dynamic` の報告生成（Phase 2）→報告だけに基づく判定（Phase 3）
- 設定: Claude Opus 5、Codex Luna Max、Codex Sol High。既存のCLI評価設定と同じモデル・reasoning effortを使用。
- 現行版の実行: `npm run build` の後に `npm run eval:prompts -- implementation-report-handoff --no-cache`

## 比較結果

変更前と最終版の保存済み出力を、同じ最終採点器で評価した。

| モデル | 変更前 | 最終版 |
|--------|--------|--------|
| Claude Opus 5 | 2 / 4 | 4 / 4 |
| Codex Luna Max | 1 / 4 | 4 / 4 |
| Codex Sol High | 1 / 4 | 4 / 4 |
| 合計 | 4 / 12 | 12 / 12 |

| ケース | 期待する遷移 | 最終版（全3モデル） |
|--------|--------------|--------------------|
| 上流にIDがあり、作業結果にはIDなし・具体的な成功証拠あり | `COMPLETE` | PASS |
| 上流の契約一覧が欠落し、一括の完了申告だけがある | `ABORT` | PASS |
| 型検査の未実装と拒否テストの失敗が明示されている | `need_replan` | PASS |
| 契約IDを定義しない計画で、各条件の成功証拠がある | `COMPLETE` | PASS |

採点対象は遷移先、完了契約表の必須ID、各行の状態欄、合成ケースのID規約に一致する未提示IDへの参照である。義務の意味、由来、主要な観測結果と状態の対応も生成された報告で確認した。

## 再現した不具合と修正

- 変更前のClaudeは、テスト工程由来の `TEST-DISC-01` を `CTR-04` に付け替えた。Lunaは `CTR-03` の契約行を省略した。
- 変更前は全3モデルが、引き継ぎ情報の欠落だけのケースを `need_replan` に分類した。
- 変更前のCodex 2モデルは、IDを定義しない計画まで台帳欠落として未完了扱いした。Solは、実装失敗が記載された報告を `COMPLETE` に分類するケースもあった。
- 最初の修正後もClaudeの証拠欄に未提示IDへの参照が残った。各契約行の証拠を自己完結させる指示を追加した。
- その後のClaudeの試行では状態列が欠落したため、状態列の必須指示と評価器の検査を追加した。実行記録の不在を「未実行」と推測しない指示も追加した。
- Lunaでは、実装失敗と別項目の情報不足が併存すると `ABORT` に分類する試行があった。具体的な実装・検証上の問題を優先し、情報不足だけの場合を `ABORT` にする遷移条件へ修正した。

最後の優先順位修正は、Lunaが実際に `ABORT` と判定した同じ報告を用いて再検証した。報告内容を変えずに新しい条件で `need_replan` となった（追加対照検証 1 / 1）。

## 測定方法と限界

- 公開builtinと合成入力だけを使用し、実runのログや実装ソースはモデルに送信していない。
- 変更前のformat/order/rulesは上記コミットから取得した。現行のruntime builderを使用し、計画・実装結果を固定したまま報告と判定を独立したCLIセッションで実行した。
- 最終の遷移条件だけを調整した後は、最終版のPhase 2出力を再利用してPhase 3を再実行した。再利用前に、新旧stepから生成されるPhase 2プロンプトが同一であることを照合した。
- 保存先は `.tmp/implementation-report-handoff-comparison`（変更前・初回修正）、`.tmp/implementation-report-handoff-final`、`.tmp/implementation-report-handoff-final2`（途中の修正）、`.tmp/implementation-report-handoff-acceptance`（最終の報告生成）、`.tmp/implementation-report-handoff-reviewed`（最終判定）。各ディレクトリに入力スナップショットと生成出力を保存した。
- 最終表は各モデル・各ケースにつき1試行。途中で指示を変更した試行は、同一条件の反復試験として数えていない。実運用全般の成功率を示すものではない。
- IDがない行のプレースホルダ表記や、影響経路・不変条件に関する全記述を網羅採点する評価ではない。
- Phase 1の実装実行、`development-core`からの全workflow実行、決定的なエンジン側の欠落検出は対象外。英語・通常/team構成はローカルの展開確認のみで、実モデル比較の対象ではない。
- この結果だけではIssue #1535全体の受け入れ条件を満たしたとは扱わない。
