# 在庫同期 / Inventory synchronization

全倉庫の在庫を個数で同期します。倉庫から受け取るケース数を下表の入数で換算し、バラ数を加えます。同じ商品でも倉庫ごとに入数が異なります。

Synchronize inventory for every warehouse in individual units. Convert the incoming case count using the units per case below, then add the loose units. Units per case vary by warehouse even for the same product.

| 倉庫コード / Warehouse code | 1ケースの入数 / Units per case |
|----------------------------|--------------------------------|
| TOKYO | 12 |
| OSAKA | 24 |
| FUKUOKA | 6 |

`syncInventory` は倉庫コード、商品コード、ケース数、バラ数の配列を受け取り、各倉庫・商品の個数を返します。未登録の倉庫コードはエラーにします。
`syncInventory` accepts records containing a warehouse code, SKU, case count, and loose unit count, and returns the unit count for each warehouse and SKU. Unknown warehouse codes are rejected.

`node --test` で在庫同期のテストを実行できます。
Run `node --test` to test inventory synchronization.
