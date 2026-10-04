# レビュー指摘裁定

## 結果: 修正対象あり

## 裁定サマリー

failed task の instruct context と PR 作成で観測された4つの問題だけを修正する。公開契約、実 artifact、実在する呼び出し経路から必要性を確認できる範囲に限定し、隣接機能を変更しない。

## 修正する問題

| 問題ID | 観測例 | 報告された場所 | 受入条件 | 修正境界 |
|--------|--------|----------------|----------|----------|
| `run-report-summary` | 日本語の final summary から要件を抽出できなかった | `src/report-summary.js` | 記録済みの supported report から単一 primary を選び、同じ構造化結果を failed context と PR 本文へ渡す | selector、parser、到達 consumer の検証だけ。未知形式の互換処理は追加しない |
| `failed-run-identity` | 元 task と一致する run が recent UI の外にあり、別 task の order を拾った | `src/run-history.js` | 保存済み identity または完全履歴の task 一致で元 run を一度解決し、該当なしでは別 task の成果物を使わない | UI の表示上限と run 優先規則は変更しない |
| `menu-pr-branch-identity` | branch metadata のない task が例外終了した | `src/pr-action.js` | 有効な同一 branch の場合だけ PR 副作用を開始する | branch 生成、rename、checkout は追加しない |
| `failed-evidence-boundary` | 一方の locale asset 経路しか回帰検証されていなかった | `src/prompt-context.js` | registry が持つ各 locale の実 asset 経路で証跡を literal data として provider へ渡す | prompt 全文固定や locale 追加は行わない |

## 未解決の前提

- なし。
