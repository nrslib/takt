```markdown
# コーディングレビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文の結論}
## 検証証跡
| 公開入口・実行モード | 成功・失敗 | 対応テスト |
|----------------------|-------------|------------|
| {入口またはモード} | {期待結果と失敗} | {テスト} |

| 資源 API | 成功・失敗・中断 | cleanup・残留物 |
|----------|------------------|----------------|
| {API} | {各経路の結果} | {後始末と残留物} |
## 再走査証跡
| 確認章数 | 未確認章（ある場合のみ） | 確認経路 | 現在の証跡 | 結果 |
|----------|--------------------------|----------|------------|------|
| 確認章数 N/N | {未確認章。なければ「なし」} | {累積差分・コード・テスト} | {現在の file:line または実行証跡} | {確認結果または未確認} |
## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載し、必須 structured output だけを機械形式とする。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は structured-output schema だけを機械 claim 形式とする。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。承認や要約を issue にしない。
```

**認知負荷軽減ルール:** 検証証跡は簡潔にするが、有効な Finding Contract 形式が要求する機械 claim は省略・打ち切りせずすべて記載する。
