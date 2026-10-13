# Payment refunds

注文の明細から合計を求め、割引と決済手数料を差し引いて返金額を小数点以下2桁に四捨五入します。小数点以下3桁目が5なら切り上げます。

The refund calculator totals the order items, subtracts the discount and processing fee, and rounds the refund to two decimal places, rounding half cents up.

`node --test` で返金計算のテストを実行できます。
Run `node --test` to test the refund calculations.
