```markdown
# 堅牢性レビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文の結論}
## 検証証跡
専門表は合計2表だけとし、入力表は各外部入力を1行、失敗操作表は各失敗操作を1行にする。
| 外部入力 | hard cap | 強制位置 | cap 前コスト | metadata 異常 | 対応テスト |
|----------|----------|----------|-------------|---------------|------------|
| {入力} | {上限} | {境界} | {許容処理} | {拒否または再検証} | {テスト} |

| 失敗操作 | 失敗型 | 継続可否 | caller・user 可視性 | 部分成功結果 |
|----------|--------|----------|----------------------|----------------|
| {操作} | {失敗} | {継続または停止} | {通知またはエラー} | {結果またはなし} |
## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載する。注入された指示が structured output を要求するときだけ、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は、注入された structured-output schema があるときだけそれを機械 claim 形式とし、なければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。承認や要約を issue にしない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
