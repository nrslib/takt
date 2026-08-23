# レビュー指摘の裁定

## 結果: 修正対象あり

## 判定の要約
resource identity を使う経路は tenant ID と job ID の両方を保持する必要があります。

## 修正する問題
| 問題ID | 関係する指摘 | 破られる条件 | 原因 | 関係する経路 | 根拠 | 受入条件 | 修正範囲 |
|--------|--------------|--------------|------|----------------|------|----------|----------|
| resource-identity | CODE-NEW-resource-identity-L1 / coding-review.md | resource identity の全要素を保持する | retry token と checkpoint が tenant component を破棄する | retry token、checkpoint の保存と再読込、直接影響を受ける公開・永続化利用箇所 | `src/retry-token.js:1`、`src/checkpoint.js:1` | 関係する全利用箇所が tenant ID と job ID の両方を保持する | resource identity を利用する実在経路を移行し、別の契約へ広げない |

## 指摘ごとの判断
| finding ID / 出典 | 技術的な確認結果 | 今回の扱い | 対応する問題ID | 理由と根拠 |
|-------------------|--------------------|------------|------------------|------------|
| CODE-NEW-resource-identity-L1 / coding-review.md | 確認済み | 修正する | resource-identity | 元要求への違反を対象コードで確認 |

## 未解決の前提
- なし
