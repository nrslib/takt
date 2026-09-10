# レビュー

## 結果: REJECT

## 継続指摘

TEST-DELIVERY-001 / persists: tests/editor.test.mjs はeditor.state.selectedRouteだけを確認し、src/delivery-client.mjs が別管理するrouteを失敗後の再送で検証していない。外部sendの失敗注入はrouteを検査する前に例外を投げる。通信層だけrouteをnullにして選択画面の値を残す退行を入れてもテストが通る。次の配送はrouteを必要とするため、誤配送や再接続が生じ得る。

修正案: 失敗を1回だけ注入した後、同じeditorから再送し、2回目のsendに渡ったrouteが元の選択先と一致することをassertする。画面・下書きの既存assertも維持する。

現行ソースが通信断・サービスエラーでrouteを実際に消すとは主張していない。今回はrequirements.mdに同じ画面からの再送・配送先維持の自動検証義務が明記されている。この必須テストが存在しないため修正を要求する。
