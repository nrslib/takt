# coding-review
## 結果: REJECT
- F-1: src/file-picker.js は表示を choosing に変えた後で showOpenFilePicker を直接呼ぶ。対象の Safari 環境では API が使えず、途中状態のまま失敗する。既存の src/file-list.js はブラウザ共通の表示処理を持ち、docs/support.md は Safari を副次環境としている。Safari でも操作できるよう整備し、Safari で確認すること。この環境では代替経路の実装とモックテストはできるが、Safari 実機での確認はできない。
