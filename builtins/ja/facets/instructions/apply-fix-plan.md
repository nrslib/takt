確定した修正計画を、依存順に最後まで実装してください。

成功条件は、直近に報告された不足箇所の修正ではなく、修正計画に含まれる全修正単位と、そこから導出した全完了義務の完了です。

**修正計画:**
{report:fix-plan.md}

{{include:instructions/completion-obligation-audit}}

**重要:**
- 編集前に、計画の根本原因、責務・正本、影響経路、方法、証拠、完了条件を現在のコード、Report Directory、有効な制約へ照合する
- 計画の各受入条件について、関係する経路と、その条件が壊れたときに検出できる失敗例を確認する。振る舞い修正、利用側移行、旧経路削除、既存条件の維持を別々に完了させる
- 変更対象外の公開API、引数、戻り値、イベント、コマンド、設定、パス、永続化形式は維持する。置換時は、現行利用側の移行、旧経路削除、明示された各支援対象を別々の完了義務として閉じる
- 同じ要求・設計前提のまま計画が矛盾する場合は編集せず、「修正計画の見直しが必要」と根拠を報告する
- タスク全体の要求または設計の変更が必要な場合は編集せず、「タスク全体の再計画が必要」と根拠を報告する

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-path-check}}

{{include:instructions/established-invariants-scan}}
{{include:instructions/post-edit-self-scan}}

結果、変更内容、受入根拠、検証結果を指定された形式で記録してください。
