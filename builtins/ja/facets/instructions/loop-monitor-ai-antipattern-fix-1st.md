ai-antipattern-review-1st と ai-antipattern-fix のループが {cycle_count} 回繰り返されました。

各サイクルのレポートを確認し、このループが健全（進捗がある）か、
非生産的（同じ問題を繰り返している）かを判断してください。

**参照するレポート:**
- AIレビュー結果: {report:ai-antipattern-review-1st.md}

**判断基準:**
- 同一 finding_id が複数サイクルにわたって persists しているか
  - 同一 finding_id が繰り返し persists → 非生産的（スタックしている）
  - 前回の finding が resolved され、新しい finding が new → 健全（進捗あり）
- 修正が実際にコードに反映されているか
