## 分野別Security Knowledgeの適用

- `security` は共通のtrust boundary判定として常に適用する
- stepに付与された `security-web`、`security-api`、`security-local`、`security-data`、`security-dependencies` だけを対象にし、それぞれの `## 適用条件` を実コード・設定・実行経路と照合する
- 技術名、拡張子、dependencyの存在だけで適用対象と判断しない
- stepに付与されていない分野Knowledgeは適用せず、そのチェック項目をfindingの根拠や網羅対象に含めない
- 付与されたKnowledgeに複数のsystem surfaceがある場合は、該当するものをすべて適用する
- team leaderとして監査を分割する場合は、各partに付与された分野Knowledgeと適用理由をpart instructionへ明記する
