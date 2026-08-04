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
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件ずつ分けて記載する。注入された指示が structured output を要求するときは、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 証跡・場所・確認証跡は、実在する1行だけを指す正確な `file:line` とする。`file:line-line` の行範囲は禁止し、複数行が必要なら行ごとに別の表行へ分ける。
- 配線証跡の証跡列は、その入口の引き渡しまたは永続化を実行する行を指す。producer や後始末の行で代用しない。
- 注入された structured-output schema がある場合は、report に記載したすべての問題を structured output にも含める。schema がなければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- サマリーまたは配線証跡で未解消の欠陥を認識した場合は issue に含めて REJECT とする。欠陥を記述したまま APPROVE しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。すべての issue の family_tag を `contract-wiring` とし、配線以外の欠陥は除外する。別領域の欠陥を付け替えない。
```

**認知負荷軽減ルール:** APPROVE はサマリーと必要な配線証跡のみとし、REJECT は補足説明を簡潔にしつつ必要な機械 claim をすべて記載する。
