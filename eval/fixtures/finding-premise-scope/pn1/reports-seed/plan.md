# タスク計画

## 要件

| # | 要件 | 由来 |
|---|------|------|
| 1 | 取引先 CSV の金額を、形式（docs/vendor-csv.md）どおりに数値として読む | タスク指示書 |
| 2 | 形式に合わない行は取り込まず、行番号と理由を返す | タスク指示書、docs/vendor-csv.md |

## 実装方針

src/import-csv.mjs の parseAmount を直し、test/import-csv.test.mjs にテストを足す。

## 確認事項

なし。
