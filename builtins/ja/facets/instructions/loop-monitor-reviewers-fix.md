reviewers → fix のループが {cycle_count} 回繰り返されました。

Finding Contract の ledger summary / `findings-ledger.json` がある場合は統合 ledger を一次情報として確認し、
ledger がない場合は Report Directory 内の最新レビューレポートを確認し、
このループが健全（収束傾向）か非生産的（発散・振動）かを判断してください。

**判断基準:**
- 同一 finding_id が複数サイクルにわたって persists しているか
  - 同一 finding_id が繰り返し persists → 非生産的（スタックしている）
  - 前回の finding が resolved され、新しい finding が new → 健全（収束傾向）
- parse 可能な Finding Contract ledger / `findings-ledger.json` がある場合は、tracked ledger `findings` / `conflicts` を正本とし、個別レポートは補助証跡として扱う
- ledger は存在するが incomplete な場合は、mapped findings は ledger に従い、unmapped raw findings は findings-manager reconciliation 待ちの potential new entries として扱う
- ledger がない、unreadable、または unparseable の場合は、Report Directory 内の最新レビューレポートを primary evidence として扱う
- 修正が実際にコードに反映されているか
- new / reopened の指摘件数が全体として減少傾向にあるか
