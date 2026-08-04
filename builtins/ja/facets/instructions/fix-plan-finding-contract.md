{{include:instructions/fix-plan-purpose}}

**重要:** このステップではソースを編集しないでください。Previous Response ではなく、Report Directory 配下を補助証拠として再帰的に確認し、live state と現在のコードを一次情報として使ってください。

**参照方針:**
- エンジンから提供された live Finding Contract ledger summary / Finding state を修正対象の正本とし、lifecycle が `new`、`persists`、`reopened` の open findings だけを計画してください
- 個別の reviewer / final gate レポートは、正本に含まれる finding の原因・再現条件・受入条件を確認する根拠として使い、resolved または closed の finding を独自に再開しないでください
- `findings[].rawFindingIds` は個別レビューへ到達する補助証跡であり、代替の正本ではありません
- 根本原因分析で集約する「未解決の指摘」は、この live state 上で lifecycle が `new`、`persists`、`reopened` の open findings に限定してください

**履歴参照条件:** `persists` / `reopened` の finding、または修正後に新しい構造問題が報告された場合に限り、各レポートの履歴を確認し、以前の修正方針で不足していた前提を特定してください。過去レポートを finding の追加または再開には使わないでください。
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
