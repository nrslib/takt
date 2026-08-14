レビューレポートの指摘を証拠で裁定し、修正してよい対象を確定してください。

{{include:instructions/contract-family-review-adjudication}}
{{include:instructions/invariant-recurrence}}

**重要:** 新しい網羅レビューは行わず、Report Directory 配下の最新レビューレポートが提出した指摘だけを対象にしてください。必要な範囲で現在のコード、要求、計画、実行証跡を確認してください。

review-resolution.md の「再発台帳の引き継ぎ」を記載してください。同じ peer-review の Report Directory 直下にある `subworkflows/iteration-N--step-remediation--*/fix-verification.md` だけを候補とし、`.takt-report-internal` 配下を除外して数値 `N` が最大の1件から全行・全13項目を無変更で記載します。候補がなければ「先行 remediation なし」、最大の `N` を一意に選べない、ファイルを読めない・欠落している、または再発記録が欠落している場合は「引き継ぎ元の欠落」と理由を記載し、古い候補から補わないでください。

**やること:**
1. 各指摘について、技術的な主張、実際に壊れるシナリオまたは実装品質問題の具体的証拠、file:line または再現証拠を確認する
2. 技術的妥当性とは別に、受入条件の直接違反、今回差分が導入した退行、必須 consumer migration、採用済み contract family の閉鎖のいずれが今回の修正を許可するか確認する。重大度、REJECT、修正案だけを権限根拠にしない
3. 各指摘を現在のコード、要求、観測可能な契約へ照合し、正式な disposition である `actionable`、`duplicate`、`false_positive`、`overreach`、`out_of_scope`、`no_issue_after_verification`、`environment_unverified` のいずれか1つへ分類する。現在のプロンプトに裁定・契約変更の判断基準が提供されている場合は適用する
4. 同じ根本原因、正本、不変条件、受入条件を持つ指摘を1つの family にまとめ、元の finding ID と出典をすべて保持する。定義から terminal・API 出力まで同じ family を縦に閉じ、隣接する別契約を混ぜない。許可済み family を閉じるために必要な未訪問 consumer は、この4条件をすべて共有する場合だけ `accepted_family_unvisited_consumer` または `required_consumer_migration` として追加できる。この例外を隣接契約の探索に広げない
5. 過剰な修正方式を退ける場合も、証拠で確認でき修正権限を持つ元の欠陥と、それを解消する最小の内部修正を失わない。技術的に妥当でも権限のない水平改善は `out_of_scope` として修正対象へ入れない
6. follow-up の新規 finding には、`accepted_family_unvisited_consumer`、`remediation_regression`、`direct_acceptance_criterion_violation`、`required_consumer_migration` のいずれかと、初回に含まれなかった理由を記録する
7. `environment_unverified` は、現在のプロンプトに環境要因の判断基準が提供され全条件を満たす場合だけ使い、実装欠陥の証拠がある指摘を環境要因で退けない
8. 指摘同士または要求・計画が競合し、現行の前提のまま修正対象を確定できない場合だけ、再計画が必要と判定する
9. 修正対象ごとに、権限根拠、破られている不変条件、関係する契約経路、完了を判定できる受入条件を記録する
10. 提出された各 finding ID をちょうど1つの裁定行へ対応付ける。`actionable` は修正対象 family を指定し、`duplicate` は同じ修正対象 family への統合先を指定する。それ以外の disposition の指摘を修正対象 family に混入させない
11. 各修正対象 family について、タスクを満たすために変更すべき範囲と、不要なスコープ拡大として明示的に除外する周辺整理・リファクタリング・互換挙動・運用保証・reviewer 提案方式を、修正境界として記録する
12. この裁定だけを次工程の正本とする。reviewer の生の判定だけでは修正を許可せず、`actionable` family とそこへ統合した `duplicate` だけを修正計画へ渡す。それ以外の指摘は、後続のコードまたは要求変更による新しい証拠がない限り除外したままにする

結果は reviewer の票数ではなく裁定後の集合で決めてください。actionable family が1件以上残る場合は、重大度、発見時期、発見率、記録済みであることにかかわらず「修正対象あり」として修正計画へ渡してください。1件もなく再計画が必要な未解決前提もない場合だけ「修正対象なし」として最終マージ準備ゲートへ送ってください。

裁定不能な懸念を非修正対象へ推測で落とさず、未解決の前提として明示してください。
