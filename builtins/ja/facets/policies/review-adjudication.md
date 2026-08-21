# レビュー指摘裁定ポリシー

提出済み指摘の技術的妥当性と今回の修正権限を分離し、許可された修正対象だけを確定する。

{{include:policies/review-scope-authority}}

## 原則

| 原則 | 基準 |
|------|------|
| 証拠優先 | 現在のコード、要求、レポート、実行証跡で確認できる事実だけを裁定根拠にする |
| 観察と権限の分離 | 技術的に妥当な欠陥でも、今回の修正を許可する根拠がなければ修正対象にしない |
| 権限根拠の限定 | 受入条件の直接違反、今回の差分が導入した退行、必須 consumer migration、採用済み contract family の閉鎖だけを修正権限にする |
| family の縦方向閉鎖 | 採用済み family は定義から terminal・API 出力まで同じ不変条件を持つ全実在経路を閉じる |
| 水平境界 | 近接性、一般品質、同じファイルという理由で隣接する別契約や改善へ広げない |
| 最小内部修正 | 既存の観測可能契約を維持する最小の内部修正で、確認済みの欠陥を解消できる形にする |
| 過剰方式の不採用 | atomicity、transaction、rollback、資源上限、互換経路など、確認済みの欠陥を超える新しい外部挙動・契約・制限・保証・運用要件を要求しない |
| 提案と権限の分離 | reviewer の重大度、REJECT、修正案、critical 分類は、今回の修正を要求する権限の根拠にしない |
| 一意な裁定 | すべての finding ID をちょうど1つの裁定へ対応付け、同じ原因だけを1つの family に統合する |
| 再計画の限定 | 指摘、要求、計画が競合し、現行の前提で修正対象を確定できない場合だけ再計画とする |

## 修正対象の範囲

| 状況 | 判定 |
|------|------|
| initial review で、提示された変更対象 family の違反が確認できる | `actionable`。裁定時に `direct_acceptance_criterion_violation` を割り当てる。initial review の「該当なし」は follow-up 分類が非適用であることを示すため、actionable family へ転記しない |
| follow-up finding が、上記「探索権限と finding・修正権限」の排他的な決定順序で1つの Authorization Basis を持つ | `actionable`、または同じ原因・受入条件を持つ既存 family への `duplicate` |
| 技術的に妥当で、実在する別契約への違反が確認できるが、排他的な決定順序で Authorization Basis を持たない | `out_of_scope` |
| 現在挙動の観察は正しくても、その挙動を欠陥とする契約根拠がなく、より強い方式・保証・一般作法だけを要求する | `overreach` |

この裁定で別の Authorization Basis 分類規則を作らない。initial-review finding では、提示された元の受入条件への違反が確認できたことから `direct_acceptance_criterion_violation` を割り当てる。follow-up finding では、reviewer が記録した因果証拠を include 済み authority policy で検証し、値が不一致または複数なら、その policy が選定する正確な機械値1つへ置き換えて不一致理由を記録する。

## 提案方式と元の欠陥

指摘本文に実在する欠陥と過剰な修正方式が併記されている場合、欠陥の事実性、修正権限、修正方式を別々に判定する。元の欠陥が修正権限を持つ場合は、finding を `actionable` または同じ family への `duplicate` とし、受入条件には必要な最小修正と既存契約の保持だけを記録する。実在する別契約への違反が技術的に確認できても権限根拠がなければ `out_of_scope` とする。現在挙動の観察だけが正しく、その挙動を違反にする契約がなく、提案された方式または保証を採用して初めて欠陥になる場合は `overreach` とする。

## 非修正の分類

`duplicate` は同じ根本原因と受入条件を持つ統合可能な指摘だけに使い、統合先 family を示す。`false_positive` / `no_issue_after_verification` は現在のコードまたは証跡が主張と矛盾する場合、`out_of_scope` は実在する別契約への違反が確認済みだが修正権限がない場合、`overreach` は観察した挙動を欠陥とする契約根拠がないまま証拠または権限を超える方式・保証を要求する場合、`environment_unverified` は環境要因の全条件を満たし実装欠陥を確認できない場合だけに使う。要求されていない環境の証跡がないというだけの指摘を、主張が反証されたものとして `no_issue_after_verification` にしない。環境条件だけが確認でき、実装欠陥が確認できない場合は `environment_unverified` とする。環境制限で実装欠陥の証拠を退けてはならない。

## 裁定の完全性

各 actionable finding には権限根拠を1つ記録し、各 family には破られた不変条件、定義・生成・正規化・検証・全 consumer・retry・fallback・parallel・永続化・復元・terminal・API 出力のうち関係する実在経路、観測可能な受入条件、修正境界を記録する。同じ family 内で権限根拠が異なる finding は family identity を維持したまま basis ごとの行へ分け、値を合成・上書きしない。未解決の actionable を重大度、発見時期、発見率、記録済みであることを理由に完了へ送ってはならない。裁定できない懸念は推測で非修正へ落とさず、未解決の前提として記録する。
