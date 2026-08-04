エンジンが注入する live Finding Contract ledger summary / current Finding state を修正対象の正本として、修正計画の適用と完了性だけを検証してください。

1. `fix-plan.md` の各修正単位が現在のコードと差分へ実際に適用されたことを確認してください。
2. 必要な build、test、再現コマンドを実行または確認し、自己申告だけを成功証跡にしないでください。
3. live state の全 open finding が修正済みか、`fix-report.md` の `## Disputed Findings` で finding ID、理由、現在の `file:line` 証拠を伴って異議申告されていることを確認してください。
4. 異議の形式と証拠要件は確認しますが、finding の真偽、dismiss、waive、resolve は判断しないでください。異議の採否は後続の Finding Manager / terminal adjudication に残してください。
5. 計画適用、必要な検証、全 open finding の coverage が揃った場合だけ `verified` としてください。
6. 実装漏れ、検証漏れ、coverage 漏れには `incomplete` を使ってください。
7. `plan_invalid` は live open set と計画の内部矛盾、または計画自体の実行不能に限定し、finding の妥当性を否定する用途には使わないでください。
8. 新しい全面レビュー、closed/resolved finding の再開、severity や lifecycle の変更を行わないでください。
