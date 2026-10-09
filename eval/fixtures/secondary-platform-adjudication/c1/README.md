# 開発ツール
対応範囲は [サポート文書](docs/support.md) を参照する。
プロジェクト実行ロックの入口は `src/project-lock.mjs` の `beginProjectRun`。新規取得時に所有者を記録し、既存ロックがあれば記録を復元して現在のプロセスと照合する。
