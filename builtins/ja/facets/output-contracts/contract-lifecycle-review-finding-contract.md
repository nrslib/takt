```markdown
# 契約ライフサイクルレビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文の結論}
## 検証証跡
専門表は合計2表だけとし、要件表は各要件を1行、資源表は各資源を1行にする。
| 要件単位 | 公開入口・実行モード | producer | validator | consumer | 対応テスト |
|----------|----------------------|----------|-----------|----------|------------|
| {要件} | {入口またはモード} | {生成元} | {検証元} | {利用元} | {テスト} |

| 資源 | owner・移譲 | last consumer | release・persist | 成功・失敗・中断・再試行 |
|------|-------------|---------------|-------------------|----------------------------|
| {資源} | {所有者と移譲} | {最終利用者} | {解放または永続化} | {各経路の結果} |
## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載し、必須 structured output だけを機械形式とする。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は structured-output schema だけを機械 claim 形式とする。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。承認や要約を issue にしない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
