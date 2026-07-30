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
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載し、必須 structured output だけを機械形式とする。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は structured-output schema だけを機械 claim 形式とする。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上とする。
```
