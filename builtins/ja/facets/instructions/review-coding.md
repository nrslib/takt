タスクの意図に対してコード差分を厳密にレビューしてください。

手順:
1. タスクの意図、計画、変更差分、実行証跡から変更契約を特定する
2. タスクに判断基準や参考資料が示されている場合は、変更契約に関係するものだけを使う
3. 実装上のバグ、既存動作のリグレッション、変更した信頼境界のセキュリティリスク、観測可能な契約のテスト不足を確認する
4. 変更した値、状態、型、schema、resolver、normalizer、adapter、共有 helper は、実在する入口から消費先まで追う
5. 副作用や状態変更では、変更契約に実在する正常・失敗・中断・後片付けの経路を確認する

{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-path-check}}
