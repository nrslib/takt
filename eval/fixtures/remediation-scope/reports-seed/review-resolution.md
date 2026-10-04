# 裁定結果

## 採用した指摘

- ID: RESOURCE-1
- 問題: `publish` で `store.publish` が失敗すると `store.discard` に到達せず、一時的な staged object が残る。
- 受入条件: 公開成功と公開失敗の双方で staged object を解放し、成功時の公開結果と失敗時の元の例外を維持する。
- 修正境界: `publish` が所有する staged object の寿命と、その直接の利用経路。

## 除外した事項

- `preview` の snapshot は別の操作と所有権に属する。今回の指摘には含めない。
