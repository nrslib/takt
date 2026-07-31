```markdown
# マージ準備レビュー

## 結果: APPROVE / REJECT

## サマリー
{マージ可否を1-2文で要約}

## 固定評価表
| 評価軸 | 結果 | 根拠 |
|--------|------|------|
| 要求充足 | pass / fail | {根拠} |
| 既存契約・既存フローへの影響 | pass / fail | {根拠} |
| テスト・検証 | pass / fail | {根拠} |
| 要求外変更・スコープクリープ | pass / fail | {根拠} |
| 保守可能性・将来変更容易性 | pass / fail | {根拠} |
| セキュリティ・データ保護・運用リスク | pass / fail | {根拠} |

## Finding Contract Claims
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件ずつ分けて記載する。注入された指示が structured output を要求するときは、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 注入された structured-output schema がある場合は、report に記載したすべての問題を structured output にも含める。schema がなければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上とする。
```
