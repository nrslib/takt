# Workflow Maker: レビュー

成果物をタスク指示および Report Directory 内の現在の `workflow-maker-doctor.md` と照合してください。実際の root workflow に対する doctor 同等の検証成功が記録されていること、参照が成果物内で解決すること、要求された振る舞いが完全に反映されていることを確認します。ファイルを編集しないでください。

`workflow-maker-doctor.md` が存在しない、読み取れない、または Validation の結果が `FAIL` の場合は `needs_fix` を選択してください。Validation の結果が `PASS` である読み取り可能なレポートなしに `approved` を選択してはいけません。

次の status を1つだけ選択してください。
- `approved`: 成果物と doctor 結果が要求を満たす。
- `needs_fix`: 具体的な欠陥が残っている。根拠と必要な修正を `workflow-maker-review.md` へ記録する。
