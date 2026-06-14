reviewers → fix のループが {cycle_count} 回繰り返されました。

Finding Contract の ledger summary / `findings-ledger.json` がある場合は統合 ledger を一次情報として確認し、
ledger がない場合は Report Directory 内の最新レビューレポートを確認し、
このループが健全（収束傾向）か非生産的（発散・振動）かを判断してください。

**判断基準:**
- 同一 finding_id が複数サイクルにわたって persists しているか
  - 同一 finding_id が繰り返し persists → 非生産的（スタックしている）
  - 前回の finding が resolved され、新しい finding が new → 健全（収束傾向）
- Finding Contract がある場合は ledger の `findings` / `conflicts` を正本とし、個別レポートは補助証跡として扱う
- 修正が実際にコードに反映されているか
- new / reopened の指摘件数が全体として減少傾向にあるか
