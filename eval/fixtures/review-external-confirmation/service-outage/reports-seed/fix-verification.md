# 検証報告
対象コード状態: d3224b23fe5ac348f608faa540967487e6ebddeb8a883c0fb6e59e1fd601fbb1。node --test は exit 0。paid / refunded の受付と再送、不正な署名、署名と期待値の欠落を拒否し状態を変えないことを確認。
実行記録:
```text
✔ paid event and replay (0.457959ms)
✔ invalid signature has no effect (0.093625ms)
✔ refund event and replay (0.040875ms)
✔ missing signature or expected signature has no effect (0.098417ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36.386125
```
