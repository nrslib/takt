修正再試行と完了性検証のループが {cycle_count} 回繰り返されました。

エンジンが提供する live Finding Contract ledger summary / current Finding state と、この cycle を発火させた `fix-verifier` の Phase 1 response だけを正本として扱ってください。Report Directory の `fix-verification.md` は今回の生成物だと保証できないため参照せず、reviewer や final gate が実行済みであるとも仮定してはいけません。

次の順序で、定義された semantic condition を1つだけ選んでください。

1. triggering response が示す未完了事項が、現行の修正計画を変えずに対処できる局所的な実装漏れ・検証漏れ・open finding coverage 漏れなら、fix-retry を選んでください。
2. triggering response が、live open set と計画の矛盾、計画上の前提破綻、または計画自体の実行不能を示し、計画更新で要件を満たせるなら、fix-plan を選んでください。
3. finding の妥当性、dismiss、waive、resolve を判断しないでください。異議の採否は後続 Finding Manager / terminal adjudication に残してください。
4. 試行済みの再修正と計画更新を踏まえても要件を満たす実行可能な方針が存在しない場合に限り ABORT を選んでください。
5. 人手裁定、台帳の手編集、resume を解決策として提案しないでください。
