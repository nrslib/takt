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

## 観測した指摘 (Observed Findings)
| # | family_tag | 重大度 | 場所 | 問題 | 影響または壊れる条件 | 修正方針 |
|---|------------|--------|------|------|----------------------|----------|
| 1 | merge-readiness | high / medium / low | `file:line` | {現在の観測欠陥} | {影響または条件} | {修正方針} |

## 解消確認 (Resolution Confirmations)
| 台帳参照 | 元の受入条件 | 確認証跡 |
|----------|--------------|----------|
| {既存指摘} | {期待結果} | `file:line` |

## 出力整合性
- Markdown の観測した指摘と structured issue、解消確認と structured confirmation はそれぞれ同じ集合にする。Markdown/structured は 1:1 にする。
- APPROVE は issue 0 件、REJECT は issue 1 件以上とする。
```
