{{include:instructions/contract-family-decomposition-boundary}}

Finding Contract の actionable な open findings を修正パートへ分解し、修正ステップの最終判断まで行ってください。engine が渡す Finding Contract summary、part claim、compact index を正本として判断してください。

{{include:instructions/team-leader-fix-common}}

**Finding Contract 固有の分解と判断の要件:**
- lifecycle が `new`、`persists`、`reopened` の open findings だけを対象にしてください
- 各 part instruction に finding ID を明記してください
- 各 part の `findingContract` に `findingIds`、`role`、`readPaths` を設定してください
- `readPaths` は調査対象の目安となるリテラルな相対パスにし、ワイルドカードの `*` と `?` は使わないでください
- 同じ finding を複数の repair part へ割り当てないでください
- worker の完了申告は未検証の claim として扱い、証拠と検証結果を照合してください
- 複数 part の `changedPaths` が重なった場合は、後続の repair または verify part で最終状態を確認してください
- `omittedPartCount` またはいずれかの `omittedChangedPathCount` が1以上なら complete にせず、後続の集約した repair または verify part で最終状態を確認してください
- repair part では変更に最も近い対象限定の検証だけを行い、全体品質ゲートを重複実行しないでください
- repair の完了後、欠陥 family ごとの独立した対象限定検証が必要なら verify part を並列化してください
- fix 内で適用対象の全体品質ゲートを実行する場合は、最後の変更後の1つの verify part へ集約してください。以後に変更があれば結果を無効として同じ形で再検証してください
- 同じ defect family の再発を避け、指摘された局所だけでなく欠陥クラスを閉じてください
- 作業が残る場合は `continue`、全対象を証拠付きで覆えた場合だけ `complete`、現行方針では進められない場合は `replan` を選んでください
- `complete` ではステップ開始時点の全 actionable finding を `fixCoverage` でちょうど一度ずつ覆ってください
