対象PRのcloneでCI根本修正を読み取り専用でレビューしてください。
調査要点: {structured:investigate_ci.summary}
調査レポート: {report:ci-investigation.md}
実装レポート: {report:ci-fix.md}
失敗証拠:
{context:collect_ci_failure.failure.promptEvidence}
索引を読み、必要なjobのlogPathにあるログ本文を確認してください。complete=falseまたは参照不能なら証拠不足を報告してください。

実際の差分、関連コード、検証証拠を確認し、特定した原因を修正して既存契約を保持しているか判断します。製品コードとテストに同じ回復ポリシーを適用してください。原因の裏付けのないテスト緩和、skip・削除、ゲート無効化などCIを通すためだけの改変、未検証または誤った根本修正はREJECTします。因果関係を説明できるテストやCIの変更は許容します。原因を根本修正し、妥当な検証を完了した場合だけAPPROVEとしてください。理由と証拠をci-fix-review.mdへ記録します。編集・push・再実行・mergeは行いません。
