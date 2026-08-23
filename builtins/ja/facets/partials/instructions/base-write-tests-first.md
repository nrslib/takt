計画に基づいて、プロダクションコードの実装前にテストを作成してください。
Workflow Contextに示されたReport Directory内のレポートのみ参照してください。他のレポートディレクトリは検索・参照しないでください。契約確認に必要なリポジトリのソース、既存テスト、設定は参照できます。

**重要: プロダクションコードは作成・変更しないでください。テストファイルのみ作成可能です。**

{{include:instructions/test-obligation-mapping}}
{{include:instructions/change-contract-traceability}}
{{include:instructions/test-contract-discrimination}}

**テストの境界:**
- 観測可能な契約を基準に作成・更新・削除を判断し、タスクにテスト関連の判断基準が示されている場合はそれにも従う
- この段階では未実装による失敗を許容するが、実装後も残るテスト欠陥は修正する

{{include:instructions/post-edit-self-scan}}
