変更された値と振る舞いの契約が、等価な入口と実行モードから最終利用・保存まで伝播するかに限定してレビューしてください。

{{include:instructions/review-investigation-discipline}}

1. 定義と参照から実在すると確認できた producer、正規化・検証、引き渡し、永続化、consumer を照合してください。現在のプロンプトに関係する判断材料が提供されている場合は適用してください。
2. 主な修正位置が値または契約の伝播・検証・保存である欠陥だけを `contract-wiring` の raw finding にしてください。
3. 資源寿命・後始末、任意操作の失敗隔離は raw finding と Observed Findings から除外してください。別領域の欠陥を `contract-wiring` として付け替えてはいけません。
4. 観測した問題は、ID、重大度、場所、根拠、修正案を付けて個別に報告してください。

**これは {step_iteration} 回目のレビューです。**
