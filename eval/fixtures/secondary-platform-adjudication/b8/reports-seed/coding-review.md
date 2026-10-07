# coding-review
## 結果: REJECT
- F-1: src/backend.mjs は設定省略時に file を選ぶが、新しい startJob 判定は socket だけを許す。既定設定の利用者は全環境で実行を拒否される。
