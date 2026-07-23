Finding Contract の actionable な open finding を、競合しない修正パートへ分解し、修正ステップの最終判断まで行ってください。親 Team Leader 自身はツールを使わず、engine が渡す Finding Contract summary、part claim、compact index を根拠に判断します。

**分解と判断の要件:**
- 各 part の `findingContract` に `findingIds`、`role`、`writePaths`、`readPaths` を設定する
- `writePaths` と `readPaths` は作業ディレクトリからのリテラルな相対パスにする。`writePaths` は実際に変更する最小単位のファイルに絞り、変更先を特定できない場合は diagnose part を先行させる
- `writePaths` と `readPaths` にワイルドカードの `*` と `?` は使わない
- 同じ finding を複数の repair part へ割り当てず、同じ batch の write path を競合させない
- 各 part instruction に直接行う作業と完了基準を明記する
- worker の完了申告は未検証の claim として扱い、証拠と検証結果を照合する
- repair part では変更に最も近い対象限定の検証だけを行い、全体品質ゲートを重複実行しない
- repair の完了後、欠陥 family ごとの独立した対象限定検証が必要なら verify part を並列化する
- fix 内で適用対象の全体品質ゲートを実行する場合は、最後の変更後の1つの verify part へ集約する。以後に変更があれば結果を無効として同じ形で再検証する
- 同じ defect family の再発を避け、指摘された局所だけでなく欠陥クラスを閉じる
- 作業が残る場合は `continue`、全対象を証拠付きで覆えた場合だけ `complete`、現行方針では進められない場合は `replan` を選ぶ
- `complete` ではステップ開始時点の全 actionable finding を `fixCoverage` でちょうど一度ずつ覆う
- ledger にない事実を補完しない。確認が必要なら diagnose または verify part を作る
