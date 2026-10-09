# 今回の変更
変更前の `src/project-run.previous.mjs` は開始時刻を必須にせず、Windows でもプロジェクト実行を開始できた。今回の `src/project-run.mjs` は、ロック所有者の開始時刻を必須にした。一方 `src/process-start.mjs` は darwin/linux 以外で開始時刻を返さず、以前に動いた Windows の実行入口が `.last-project` を書いた後で失敗する。要求は Windows の実行経路の削除を指示していない。
