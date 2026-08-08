```markdown
# 最終ゲート要約

## 結果: APPROVE / REJECT / NEED_REPLAN

## 要点
{実際の判定と、その根拠となる要点を1-2文で要約}

## 次アクションまたは未完了理由
{APPROVE では次の進行、REJECT では修正、NEED_REPLAN では未確認事項と再計画理由}

## Finding Contract Claims
{観測した欠陥または明示的な台帳 lifecycle claim を、ここに1件1エントリで記載する。各エントリは注入された Finding Contract 指示のラベル付きフィールド形式（Target files / Description / Evidence）に従う。severity・重大度ラベル・問題系列タグは書かない。指摘表は使わない。claim がなければ `None` と記載する。}

## 出力整合性
- 通常の Markdown report 本文だけを返す。JSON や structured output は返さない。最終 finding ID は採番しない。
- APPROVE は issue 0 件、REJECT は issue 1 件以上。NEED_REPLAN は issue 0 件のまま未確認事項を次アクションまたは未完了理由に記録する。承認や要約を issue にしない。
```

**認知負荷軽減ルール:** 実際の判定、要点、次アクションまたは未完了理由を必ず記載し、必要な機械 claim は省略・打ち切りせずすべて記載する。
