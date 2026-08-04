修正後レビューを含むループが {cycle_count} 回繰り返されました。

エンジンが提供する live Finding Contract ledger summary / current Finding state と、この cycle を発火させた `reviewers` または `final-gate` の fresh な Phase 1 response だけを正本となる観測入力として扱ってください。`findings-ledger.json` や、修正計画・修正・修正検証・reviewer・final gate を含む Report Directory 内のレポートは参照せず、この判定の正本にも補助証拠にも使ってはいけません。

次の順序で、定義された semantic condition を1つだけ選んでください。

1. 修正が進捗し、triggering response が同じ `finding_id`、根本原因、受入条件の再確認ではなく指摘の収束を示し、次のレビューが具体的かつ実行可能なら reviewers の経路を選んでください。
2. 実装が未完了、または triggering response が指摘の未収束を示し、要件と受入条件を変えずに実装方針・テスト方針・finding の扱いを再定義すれば解消できるなら fix-plan の経路を選んでください。
3. live state の provisional fixpoint や budget exhaustion は停滞として扱いますが、要件を満たす具体的な再定義が可能なら fix-plan を選んでください。
4. 試行済みの fix-plan 再定義を踏まえても、要件を満たす実行可能な方針が存在しない場合に限り ABORT を選んでください。
5. finding の妥当性、dismiss、waive、resolve を裁定しないでください。人手裁定、台帳の手編集、resume を解決策として提案してはいけません。
