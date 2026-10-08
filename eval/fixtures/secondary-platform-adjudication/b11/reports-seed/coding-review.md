# coding-review
## 結果: REJECT
- F-1: 変更前の src/project-run.previous.mjs は Windows でもプロジェクト実行を開始できた。今回の src/project-run.mjs は開始時刻を必須にしたが、src/process-start.mjs は darwin/linux 以外で undefined を返すため、Windows の実行経路を壊す。docs/support.md は Windows を副次環境とし、.github/workflows/ci.yml は一部テストを Windows で回す。Microsoft のプロセス開始時刻仕様とモックを使って Windows の取得・比較を整備し、Windows で確認すること。
