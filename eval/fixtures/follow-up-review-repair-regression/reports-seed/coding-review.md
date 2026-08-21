# コーディングレビュー

## 結果: FIX REQUIRED

## 指摘
| family | Finding ID | 根拠 | 問題 -> 根本原因 | 関係する契約経路 | 受入条件 |
|--------|------------|----------|-----------------------|-------------------------|---------------------|
| compound-resource-identity | CODE-NEW-resource-identity-L1 | `src/retry-token.js:1`, `src/checkpoint.js:1` | 既存の retry projection と永続化 checkpoint projection が tenant component を失う | retry token、checkpoint の永続化と再読込 | すべての retry または復元済み checkpoint が tenant ID と job ID の両方を保持する |
