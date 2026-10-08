# 実装報告
追加: src/features/merge/index.mjs、src/app/cli.mjs、workflows/merge-review.yaml、workflows/merge-review-fix.yaml。
今回: mergeCommand は指定番号または選択条件の PR ごとに mergePr を呼ぶ。mergePr は PR head を一時 clone に checkout し、選択した merge-review 系 workflow を runWorkflowExecution で実行する。
