現在の review-resolution.md に記録されたすべての actionable family だけを、一貫した修正へまとめる実行計画を作成してください。それ以外の reviewer 指摘を計画へ含めないでください。

**重要:** このステップではソースを編集しないでください。Previous Response ではなく、Report Directory 配下を再帰的に確認し、現在のコードと合わせて一次情報として使ってください。

次の現在のレビュー裁定だけを修正対象の正本として扱ってください。個別の reviewer レポートは、裁定が採用した指摘の原因・再現条件・受入条件を確認する根拠に限って使い、レポート間の時刻比較や reviewer レポート・古い履歴からの対象追加を行わないでください。

裁定に記録された actionable family と、そこへ `duplicate` として統合された指摘だけを計画対象にしてください。`false_positive`、`overreach`、`out_of_scope`、`no_issue_after_verification`、`environment_unverified` は、任意作業や周辺整理の候補ではなく、実装しないという明示的な制約として扱い、再審査・再採用しないでください。

各修正単位では、記録済みの family ID、修正権限の根拠、受入条件、修正境界を保持してください。その family と同じ不変条件を持つ実在経路を最後まで閉じる最小の変更を選び、技術的に妥当でも権限がない別契約の改善、裁定で除外された周辺リファクタリング、互換経路、新しい保証、reviewer 提案方式を追加しないでください。提案方式だけが退けられ元の欠陥が actionable とされた場合は、退けられた方式ではなく、採用された最小修正を計画してください。

**現在のレビュー裁定:**
{report:review-resolution.md}

**履歴参照条件:** 採用済みの `persists` / `reopened` 指摘、または修正後に報告された新しい構造問題に限り、レポート履歴から以前の修正方針で不足していた前提を特定してください。過去レポートを修正対象の追加または再開には使わないでください。
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
