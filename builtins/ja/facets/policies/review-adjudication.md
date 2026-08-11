# レビュー指摘裁定ポリシー

提出済み指摘の技術的妥当性と今回の修正権限を分離し、許可された修正対象だけを確定する。

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
| 元要求・受入条件へ直接違反している | `actionable` — `direct_acceptance_criterion_violation` |
| 今回の差分または修正が、変更前に存在しなかった退行を導入した | `actionable` — `remediation_regression` |
| 変更・置換した契約を成立させる現行 consumer の移行が必須である | `actionable` — `required_consumer_migration` |
| 既に採用した contract family と同じ不変条件を持つ未確認 consumer の欠陥である | `actionable` または同じ family への `duplicate` — `accepted_family_unvisited_consumer` |
| 技術的に妥当だが、上記の権限根拠を持たない別契約の品質欠陥・改善である | `out_of_scope` |
| 実在する欠陥の証拠がなく、より強い方式・保証・一般作法だけを要求する | `overreach` |

## 提案方式と元の欠陥

指摘本文に実在する欠陥と過剰な修正方式が併記されている場合、欠陥の事実性、修正権限、修正方式を別々に判定する。元の欠陥が修正権限を持つ場合は、finding を `actionable` または同じ family への `duplicate` とし、受入条件には必要な最小修正と既存契約の保持だけを記録する。元の欠陥が技術的に妥当でも権限根拠がなければ `out_of_scope` とし、欠陥の証拠がなく方式だけを要求していれば `overreach` とする。

## 非修正の分類

`duplicate` は同じ根本原因と受入条件を持つ統合可能な指摘だけに使い、統合先 family を示す。`false_positive` / `no_issue_after_verification` は現在のコードまたは証跡が主張と矛盾する場合、`out_of_scope` は確認済みだが修正権限のない別契約の欠陥・改善、`overreach` は証拠または権限を超える方式・保証の要求、`environment_unverified` は環境要因の全条件を満たし実装欠陥を確認できない場合だけに使う。環境制限で実装欠陥の証拠を退けてはならない。

## 継続レビューの新規指摘

follow-up の修正対象を解消へ向けて収束させる。新規 finding を採用する場合は、`accepted_family_unvisited_consumer`、`remediation_regression`、`direct_acceptance_criterion_violation` のいずれかと、初回に含まれなかった理由を記録する。初回から存在したことは、採用済み family の未確認 consumer を非修正にする根拠にならず、水平な新規 family は作らず同じ family へ紐付ける。一方、隣接する別契約の水平改善は新規 finding として修正計画へ渡さない。

## 裁定の完全性

各 actionable family には、権限根拠、破られた不変条件、定義・生成・正規化・検証・全 consumer・retry・fallback・parallel・永続化・復元・terminal・API 出力のうち関係する実在経路、観測可能な受入条件、修正境界を記録する。未解決の actionable を重大度、発見時期、発見率、記録済みであることを理由に完了へ送ってはならない。裁定できない懸念は推測で非修正へ落とさず、未解決の前提として記録する。
