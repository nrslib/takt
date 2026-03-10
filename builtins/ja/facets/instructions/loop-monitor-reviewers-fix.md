reviewers → fix のループが {cycle_count} 回繰り返されました。

Report Directory 内の最新レビューレポートを確認し、
このループが健全（収束傾向）か非生産的（発散・振動）かを判断してください。

**判断基準:**
- 同一 finding_id が複数サイクルにわたって persists しているか
  - 同一 finding_id が繰り返し persists → 非生産的（スタックしている）
  - 前回の finding が resolved され、新しい finding が new → 健全（収束傾向）
- 修正が実際にコードに反映されているか
- new / reopened の指摘件数が全体として減少傾向にあるか
