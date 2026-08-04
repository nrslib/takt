{{include:instructions/loop-monitor-fix-replan-purpose}}

エンジンが提供する live Finding Contract ledger summary / current Finding state と、`fix-plan` へ戻る遷移を発火させた current-cycle の `fix`、`fix-retry`、または `fix-verifier` の fresh な Phase 1 response だけを正本となる観測入力として扱ってください。`findings-ledger.json` や、計画・レビュー・修正・修正検証を含む Report Directory 内のレポートは参照せず、この判定の正本にも補助証拠にも使ってはいけません。

{{include:instructions/loop-monitor-fix-replan-common}}

live state で同一 finding / family が再発している場合や provisional の fixpoint / budget exhaustion がある場合は、停滞の証拠として扱ってください。それでも要件を満たす具体的な別案がある場合は replan を選び、試行済みの再定義でも実現可能な方針を作れない場合だけ ABORT を選んでください。finding の妥当性、dismiss、waive、resolve を裁定しないでください。人手裁定、台帳の手編集、resume を解決策として提案しないでください。
