```markdown
# 最終ゲート要約

## 結果: APPROVE / REJECT / NEED_REPLAN

## 要点
{実際の判定と、その根拠となる要点を1-2文で要約}

## 次アクションまたは未完了理由
{APPROVE では次の進行、REJECT では修正、NEED_REPLAN では未確認事項と再計画理由}

## Finding Contract Claims
{注入された Finding Contract 指示に canonical block protocol がある場合は、観測した欠陥または明示的な台帳 lifecycle claim ごとに正確に1つの block を出力する。protocol がない場合は、claim を通常の文章で記載する。注入された指示が structured output を要求するときだけ、その schema を機械形式として使い、要求がなければ Markdown report だけを返す。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- canonical block protocol がある場合は、block と normalized item を同じ順序集合とし、rawExcerpt を byte-exact に一致させる。protocol がない場合は、注入された structured-output schema があるときだけそれを機械 claim 形式とし、なければ通常の report 本文だけを使う。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。NEED_REPLAN は issue 0 件のまま未確認事項を次アクションまたは未完了理由に記録する。承認や要約を issue にしない。
```

**認知負荷軽減ルール:** 実際の判定、要点、次アクションまたは未完了理由を必ず記載し、必要な機械 claim は省略・打ち切りせずすべて記載する。
