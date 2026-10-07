# coding-review
## 結果: REJECT
- F-1: 新しい src/job.mjs の秘密情報保存は、存在しない .job-state ディレクトリへ書くため Linux と Windows の両方で失敗する。同じ保存処理は、ディレクトリを作っても Windows では mode: 0o600 だけで保護しようとし、秘密情報の所有者限定を保証できない。変更前に Windows でこの保存処理を使う経路はなく、既存の src/platform-path.mjs は接続先の選択だけを担う。docs/support.md は Windows を副次とし、.github/workflows/ci.yml は一部テストを Windows で回す。Linux の失敗を直し、Windows でも秘密情報を保護して動作させ、Windows で確認すること。
