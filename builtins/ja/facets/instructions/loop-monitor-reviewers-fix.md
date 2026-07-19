reviewers → fix のループが {cycle_count} 回繰り返されました。

Finding Contract の ledger summary / `findings-ledger.json` がある場合は統合 ledger を一次情報として確認し、
ledger がない場合は Report Directory 内の最新レビューレポートを確認し、
このループが健全（収束傾向）か非生産的（発散・振動）かを判断してください。

**判断基準:**
- 同一 finding_id が複数サイクルにわたって persists しているか
  - 同一 finding_id が繰り返し persists → 非生産的（スタックしている）
  - 前回の finding が resolved され、新しい finding が new → 原則は健全（収束傾向）
    - ただし新しい finding が、直近で resolved された finding と同一 `family_tag` の別分岐である場合は、部分修正による再発とみなし非生産的側に数える。同一 `family_tag` が分岐単位で繰り返し再発し closed へ向かわない場合は、全分岐の一括修正を促す再計画を選ぶ。ABORT 判断は末尾の基準（修正・再計画・異議申告のいずれでも打開できない場合のみ）に従う
- parse 可能な Finding Contract ledger / `findings-ledger.json` がある場合は、tracked ledger `findings` / `conflicts` を正本とし、個別レポートは補助証跡として扱う
- ledger は存在するが incomplete な場合は、mapped findings は ledger に従い、unmapped raw findings は findings-manager reconciliation 待ちの potential new entries として扱う
- ledger がない、unreadable、または unparseable の場合は、Report Directory 内の最新レビューレポートを primary evidence として扱う
- 修正が実際にコードに反映されているか
  - 修正は反映済みなのに同じ指摘が続く（指摘が現状コードと乖離している）場合、
    行き詰まりの原因はコードではなく指摘の側にある。この場合は異議申告
    （dispute → manager 裁定 → waive）という打開手段が残っているため、
    「再計画で打開できる」と判断して計画への差し戻しを選ぶこと
- new / reopened の指摘件数が全体として減少傾向にあるか

打ち切り（ABORT）を選ぶのは、修正・再計画・異議申告のどの手段でも打開できないと
判断できる場合だけにしてください。
