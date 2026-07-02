# レビュー指摘追跡ポリシー

レビュー指摘の ID、lifecycle、再オープン、履歴追跡を一貫して扱う。

## 原則

| 原則 | 基準 |
|------|------|
| workflow単位 | Finding Contract は individual finding 単位ではなく review workflow 全体に適用する |
| 正本優先 | ledger が利用できる場合、tracked findings の正本は ledger とする |
| ID一意性 | 同一 `finding_id` に別問題を混在させない |
| 再現可能性 | reopened 判定には再現手順、期待結果と実結果、失敗箇所を要求する |
| 履歴優先 | finding 状態は記憶や Previous Response ではなくレポート履歴と ledger から判定する |

## Finding Contract の適用条件

Finding Contract workflow かどうかは、workflow レベルの `finding_contract` 設定が宣言されている場合に限って判定する。

| 基準 | 判定 |
|------|------|
| workflow レベルに `finding_contract` 設定がある | Finding Contract workflow |
| `findings-ledger.json` だけが存在する | Finding Contract を有効化しない |
| instruction 内に Finding Contract セクションだけがある | Finding Contract を有効化しない |
| output contract に `Observed Findings` table だけがある | Finding Contract を有効化しない |

## Finding Contract 利用時の指摘報告

| 基準 | 判定 |
|------|------|
| レビュワーが新規の最終 `finding_id` を採番する | REJECT |
| レビュワーが `new` / `persists` / `resolved` / `reopened` の lifecycle 分類を行う | REJECT |
| 観測した問題を raw finding として報告する | OK |
| ledger に載っている既存 ID への言及 | OK |
| ledger にない ID を既存 ID として扱う | REJECT |

ID 採番と lifecycle 対応づけは findings-manager とエンジンの責務である。

## ledger とレポート履歴の優先順位

| 状況 | 扱い |
|------|------|
| parse 可能な ledger がある | ledger を tracked findings の正本にする |
| ledger が存在するが不完全 | mapped findings は ledger に従い、unmapped raw findings は reconciliation 待ちにする |
| Finding Contract workflow で parse 可能な ledger がない | 最新レビューは observed raw findings の補助証跡としてのみ使う |
| Finding Contract を使わない workflow | 最新レビューと履歴を primary evidence とし、従来ルールを適用する |

## 従来の Finding ID ルール

workflow レベルの `finding_contract` 設定がない場合は、以下の従来ルールに従う。

- REJECT時に挙げる各問題には `finding_id` を必須で付ける
- 同じ問題を再指摘する場合は、同じ `finding_id` を再利用する
- 再指摘時は状態を `persists` とし、未解決である根拠を必ず示す
- 新規指摘は状態 `new` とする
- 解消済みは状態 `resolved` として一覧化する
- `finding_id` のない指摘は無効とする。この legacy 基準は Finding Contract workflow には適用しない
- REJECTは `new` または `persists` の問題が1件以上ある場合のみ許可する
- 前回指摘を解消済みとする場合、別の構造問題や契約悪化を新たに導入していないか確認する

## 再オープン条件

解消済み指摘を再オープンする場合は、再現可能な根拠を必須とする。

| 基準 | 判定 |
|------|------|
| 再現手順、期待結果と実結果、失敗箇所が揃っている | reopened 可 |
| 上記のいずれかが欠ける | REJECT根拠として無効 |
| 再現条件が変わる | 別問題として新規 `finding_id` を発行する |

## finding_id の意味固定

同じ ID に別問題を混在させない。

- 同一 `finding_id` は同一問題にのみ使用する
- 問題の意味、根拠、再現条件が変わる場合は新規 `finding_id` を発行する
- 同一 `finding_id` の説明を後から別問題に差し替えることを禁止する

## 前回指摘の追跡

| 基準 | 判定 |
|------|------|
| ledger が使える | open findings のみを修正対象にし、resolved / closed findings は修正対象外とする |
| レポート履歴を使う | 最新結果と直前履歴を比較し、open findings を今回レポートから欠落させない |
| Previous Response だけで状態判定する | REJECT |
| `resolved` を修正差分の有無だけで判定する | REJECT |
| `resolved` を元 finding の期待結果と元要件で判定する | OK |
