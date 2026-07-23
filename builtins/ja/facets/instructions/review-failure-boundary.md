必須処理と任意処理の失敗境界、継続可否、部分結果の可視性に限定してレビューしてください。

1. Knowledge の全文を読み、正常系を確定してから、各失敗が主結果、caller、利用者へどう伝播するか比較してください。
2. 主な修正位置が `catch` / `throw`、失敗分類、集約、継続・停止、部分結果の表現である欠陥だけを `failure-boundary` の raw finding にしてください。
3. 単なる値の配線や資源解放位置は raw finding と Observed Findings から除外してください。別領域の欠陥を `failure-boundary` として付け替えてはいけません。
4. 例えば保存時に値を欠落させる欠陥は失敗境界ではないため除外し、任意処理の例外が主結果まで失敗させる欠陥は対象にしてください。
5. 観測した問題は Finding Contract の単位に従って個別の raw finding とし、重複の統合は findings-manager と ledger に委ねてください。

**これは {step_iteration} 回目のレビューです。**
