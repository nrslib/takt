# 修正報告
対象問題: P-1 / F-1。現在のコード状態: c59484b65b031cf5bbaafef17c249e1123b5729eaf46cbd764d9d7953a697a37。
refunded を既存の receive 経路へ渡せるように修正し、両イベントの再送と不正署名の回帰テストを用意した。修正内容は現在のコードを参照。

## ローカル検証
実行コマンド: node --test eval/fixtures/supervise-external-confirmation/basis-not-applicable/app.test.mjs。exit 0。
```text
✔ paid event and replay (0.458208ms)
✔ invalid signature has no effect (0.089584ms)
✔ refund event and replay (0.042125ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.059625
```
