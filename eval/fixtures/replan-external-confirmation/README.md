# 再計画の外部確認引き継ぎ

handoff の seed は、コードと環境内の検証が完了した後の BLOCKED 出力を表す。
最終判定の各条件を確認事項へ保存する計画だけを評価し、実際の手渡しや本番の確認は実行しない。
採点は fixture 外の suite YAML に置く。code-state.json は app.mjs と app.test.mjs の連結の SHA-256。
