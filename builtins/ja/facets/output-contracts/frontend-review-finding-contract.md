```markdown
# フロントエンドレビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文で結果を要約}
## 確認した観点
| 観点 | 結果 | 備考 |
|------|------|------|
| コンポーネント設計 | ✅ | - |
| 状態管理 | ✅ | - |
| 正規状態と派生状態 | ✅ | - |
| パフォーマンス | ✅ | - |
| アクセシビリティ | ✅ | - |
| 型安全性 | ✅ | - |

## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載する。注入された指示が structured output を要求するときだけ、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は、注入された structured-output schema があるときだけそれを機械 claim 形式とし、なければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。承認や要約を issue にしない。

## REJECT判定条件
- ブロッキング指摘が1件以上ある場合のみ REJECT
```

**認知負荷軽減ルール:**
- APPROVE かつ lifecycle claim なし → サマリーのみ
- APPROVE かつ confirmation あり → サマリーと有効な Finding Contract 形式の必要 claim
- REJECT → 有効な Finding Contract 形式で関連 claim をすべて記載
