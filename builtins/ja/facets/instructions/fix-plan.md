{{include:instructions/fix-plan-purpose}}

**重要:** このステップではソースを編集しないでください。Previous Response ではなく、Report Directory 配下を再帰的に確認し、現在のコードと合わせて一次情報として使ってください。

**参照方針:** Report Directory の最新レビューレポートを修正対象の正本とし、別レポートとの時刻比較や古い履歴からの対象追加を行わないでください。個別の reviewer / final gate レポートは、正本に含まれる指摘の原因・再現条件・受入条件を確認する根拠として使い、正本が修正対象としていない指摘を独自に再開しないでください。

**履歴参照条件:** `persists` / `reopened` の指摘、または修正後に新しい構造問題が報告された場合に限り、各レポートの履歴を確認し、以前の修正方針で不足していた前提を特定してください。過去レポートを修正対象の追加または再開には使わないでください。
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
