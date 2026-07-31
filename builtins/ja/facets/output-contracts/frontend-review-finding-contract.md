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
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件ずつ分けて記載する。注入された指示が structured output を要求するときは、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 注入された structured-output schema がある場合は、report に記載したすべての問題を structured output にも含める。schema がなければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。承認や要約を issue にしない。

## REJECT判定条件
- ブロッキング指摘が1件以上ある場合のみ REJECT
```

**認知負荷軽減ルール:**
- APPROVE かつ lifecycle claim なし → サマリーのみ
- APPROVE かつ confirmation あり → サマリーと有効な Finding Contract 形式の必要 claim
- REJECT → 有効な Finding Contract 形式で関連 claim をすべて記載
