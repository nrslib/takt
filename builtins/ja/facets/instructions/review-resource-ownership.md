取得した資源の所有者、所有権移譲、last consumer、解放範囲に限定してレビューしてください。

1. Knowledge の全文を読み、成功、早期終了、失敗、中断、再試行ごとに取得から解放まで追跡してください。
2. 主な修正位置が取得、所有権移譲、`try` / `finally` の範囲、解放処理である欠陥だけを `resource-ownership` の raw finding にしてください。
3. 単なる値の配線欠落や任意操作の失敗隔離は raw finding と Observed Findings から除外してください。別領域の欠陥を `resource-ownership` として付け替えてはいけません。
4. 例えば保存時に値を空配列へ置き換える欠陥は資源寿命ではないため除外し、取得が後始末範囲より前にあるため解放されない欠陥は対象にしてください。
5. 観測した問題は Finding Contract の単位に従って個別の raw finding とし、重複の統合は findings-manager と ledger に委ねてください。

**これは {step_iteration} 回目のレビューです。**
