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
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件1エントリで記載する。各エントリは注入された Finding Contract 指示のラベル付きフィールド形式（Target files / Description / Evidence）に従う。claim に分類フィールド（Severity / Title / Family Tag / Relation）を書かない。分類と同一性は下流が決める。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 証跡・場所・確認証跡は、実在する1行だけを指す正確な `file:line` とする。`file:line-line` の行範囲は禁止し、複数行が必要なら行ごとに別の表行へ分ける。
- 捕捉、caller・user 可視性、部分結果保持が別の行なら、それぞれ別の失敗境界証跡行にして直接の証跡を示す。
- 通常の Markdown report 本文だけを返す。JSON や structured output は返さない。最終 finding ID は採番しない。
- サマリーまたは失敗境界証跡で未解消の欠陥を認識した場合は issue に含めて REJECT とする。欠陥を記述したまま APPROVE しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。失敗境界以外の欠陥は報告しない。別領域の欠陥を付け替えない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な失敗境界証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
