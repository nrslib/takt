# レビュー指摘裁定

## 結果: 修正対象あり

## 裁定サマリー
compound resource identity の finding は actionable です。直接影響を受けるすべての公開 projection と永続化 projection は、tenant ID と job ID の両方を保持しなければなりません。

## 要求判断の根拠
| 対象 | 状態 | 根拠 |
|---------|--------|---------|
| compound resource identity | 未充足 | `src/retry-token.js` と `src/checkpoint.js` が tenant component を欠落させる |

## 不変条件の再発記録
引継元: 初回コーディングレビュー

| 修正単位 | Family ID | 不変条件名 | 担当箇所 | 今回の検証回数 | 前回の検証回数 | 前回経路 | 今回経路 | 同一不変条件・再発判定 | 累積 `incomplete` 回数 | 別経路での再発確認 | 強制点候補 | 記録の完全性 |
|----------|-----------|----------------|--------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|-------------------------------------------|-----------------------------|------------------|

## 修正対象 family
| family | Finding ID / 出典 | 根拠 | 問題 -> 根本原因 | 関係する契約経路 | 受入条件 | 修正境界 |
|--------|---------------------|------|-----------------------|-------------------------|---------------------|----------------------|
| compound-resource-identity | CODE-NEW-resource-identity-L1 / coding-review.md | 元要求への違反を `src/retry-token.js:1`, `src/checkpoint.js:1` で確認 | retry projection と checkpoint projection が compound identity の一部を破棄する | retry token、checkpoint の永続化と再読込、直接影響を受ける公開および永続化 identity consumer | 直接影響を受けるすべての identity projection が tenant ID と job ID の両方を保持する | この accepted family のすべての consumer を移行し、remediation が導入する regression を防ぐ |

## 指摘ごとの裁定
| Finding ID / 出典 | 技術的妥当性 | 裁定 | 対象 family | 根拠 |
|---------------------|--------------------|-------------|---------------|------|
| CODE-NEW-resource-identity-L1 / coding-review.md | 確認済み | actionable | compound-resource-identity | 元要求への違反を `src/retry-token.js:1`, `src/checkpoint.js:1` で確認。 |

## 未解決の前提
- なし。
