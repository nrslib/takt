# 注文管理

社内の注文管理アプリ。現在は注文の内容を確認できる。
`src/routes/` に画面、`src/features/orders/` に注文の型・API・表示部品を置く。

`npm install` 後に `npm run dev` で起動、`npm run build` で型検査とビルドを行う。
開発用ホストは以下の `/api` を提供する。バックエンドの実装はこのプロジェクトの範囲外。

- `GET /api/orders/:id`: `Order`
- `GET /api/customers`: `Customer[]`
- `GET /api/products`: `Product[]`
- `PUT /api/orders/:id`: `Order` を受信し、確定した `Order` を返す。失敗時は非 2xx。

金額は税込の整数円。顧客には `standard` / `partner` の価格区分があり、
商品ごとの `prices` に各区分の単価を持つ。注文の明細は商品IDと数量を保存する。
`/orders/42` を直接開くと注文42を表示する。
