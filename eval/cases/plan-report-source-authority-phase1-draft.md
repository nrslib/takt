## 調査結果

`exportReport` は現在 line-based output を生成する。リポジトリには grouped sections を生成する実験 module もあり、既存 test の一部はその exact heading を使用している。

### 計画案

- optional limit を public `exportReport` へ追加する。
- limit 省略時は現在の output を維持する。
- non-negative integer のとき input order を保って件数を制限する。
- negative/non-integer を public entry point で拒否する。
- 実験 module に合わせ、grouped sections への移行を必須要件とする。
- 新しい `ExportLimitPolicy` class と `GroupedExportResult` type を追加する。
- limit の default を100とし、超過時は warning を記録する。

最後の3項目は現行コードや実装上の候補から作った案であり、元タスクには要求されていない。
