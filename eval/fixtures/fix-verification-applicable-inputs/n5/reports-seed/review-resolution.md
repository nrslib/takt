# レビュー裁定

## 結果: 修正対象あり

## 指摘一覧
| finding ID | 問題 | 扱い | 根拠 | 受入条件 |
|------------|------|------|------|----------|
| R-1 | 一覧が顧客と日付だけを表示し、同じ顧客と日付の複数明細を見分けられなかった | 修正対象 | src/admin.mjs、src/store.mjs、src/list.mjs、src/summary.mjs、src/shared/money.mjs、schema/invoices.json、docs/usage.md、src/import-csv.mjs、examples/vendor.csv | 同じ顧客・同じ日付の明細が複数あっても、一覧で見分けられる |

## 修正境界
保存済みの ID と金額、登録順、重複登録の拒否、登録時の入力検証、合計画面の計算と表示を維持する。
