# 台帳の集計修正

- 台帳の全件の金額を合計し、件数を返す。空の台帳は件数0と合計0を返す。
- 既存の出力を保持し、空のデータも扱う。
- test/summary.test.mjs と test/empty.test.mjs で確かめる。

## 作業の制約
この工程では src/report.mjs を変えない。
