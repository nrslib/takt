```markdown
# 失敗境界レビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文の結論}
## 失敗境界証跡
| 操作 | 必須・任意 | 失敗分類 | 継続・停止 | caller・user 可視性 | 部分結果 | 証跡 |
|------|-----------|----------|-----------|----------------------|----------|------|
| {操作} | {必須または任意} | {失敗型} | {継続または停止} | {通知またはエラー} | {保持する結果またはなし} | `file:line` |
## Finding Contract Claims
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件ずつ分けて記載する。注入された指示が structured output を要求するときは、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 証跡・場所・確認証跡は、実在する1行だけを指す正確な `file:line` とする。`file:line-line` の行範囲は禁止し、複数行が必要なら行ごとに別の表行へ分ける。
- 捕捉、caller・user 可視性、部分結果保持が別の行なら、それぞれ別の失敗境界証跡行にして直接の証跡を示す。
- 注入された structured-output schema がある場合は、report に記載したすべての問題を structured output にも含める。schema がなければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- サマリーまたは失敗境界証跡で未解消の欠陥を認識した場合は issue に含めて REJECT とする。欠陥を記述したまま APPROVE しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。すべての issue の family_tag を `failure-boundary` とし、失敗境界以外の欠陥は除外する。別領域の欠陥を付け替えない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な失敗境界証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
