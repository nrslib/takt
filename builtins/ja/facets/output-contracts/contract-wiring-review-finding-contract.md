```markdown
# 契約配線レビュー
## 結果: APPROVE / REJECT
## サマリー
{1-2文の結論}
## 配線証跡
| 入口・実行モード | producer | 正規化・検証 | 引き渡し・永続化 | consumer | 証跡 |
|-------------------|----------|---------------|-------------------|----------|------|
| {入口またはモード} | {生成元} | {検証元} | {引き渡しまたは保存先} | {利用元} | `file:line` |
## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載し、必須 structured output だけを機械形式とする。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 証跡・場所・確認証跡は、実在する1行だけを指す正確な `file:line` とする。`file:line-line` の行範囲は禁止し、複数行が必要なら行ごとに別の表行へ分ける。
- 配線証跡の証跡列は、その入口の引き渡しまたは永続化を実行する行を指す。producer や後始末の行で代用しない。
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は structured-output schema だけを機械 claim 形式とする。最終 finding ID は採番しない。
- サマリーまたは配線証跡で未解消の欠陥を認識した場合は issue に含めて REJECT とする。欠陥を記述したまま APPROVE しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。すべての issue の family_tag を `contract-wiring` とし、配線以外の欠陥は除外する。別領域の欠陥を付け替えない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な配線証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
