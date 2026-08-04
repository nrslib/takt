変更された値と振る舞いの契約が、等価な入口と実行モードから最終利用・保存まで伝播するかに限定してレビューしてください。

1. Knowledge の全文を読み、入口ごとに producer、正規化・検証、引き渡し、永続化、consumer を照合してください。
2. 主な修正位置が値または契約の伝播・検証・保存である欠陥だけを `contract-wiring` の raw finding にしてください。
3. 資源寿命・後始末、任意操作の失敗隔離は raw finding と Observed Findings から除外してください。別領域の欠陥を `contract-wiring` として付け替えてはいけません。
4. 観測した問題は Finding Contract の単位に従って個別の raw finding とし、重複の統合は findings-manager と ledger に委ねてください。

**これは {step_iteration} 回目のレビューです。**
