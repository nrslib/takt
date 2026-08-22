# コーディングレビュー

## 結果: FIX REQUIRED

## 指摘
| Finding ID | 根拠 | 問題と原因 | 関係する経路 | 受入条件 |
|------------|------|------------|----------------|----------|
| CODE-NEW-resource-identity-L1 | `src/retry-token.js:1`、`src/checkpoint.js:1` | retry token と checkpoint が resource identity の tenant component を失う | retry token、checkpoint の保存と再読込 | すべての retry と復元済み checkpoint が tenant ID と job ID の両方を保持する |
