計画に基づいて、プロダクションコードの実装前にテストを作成してください。
Workflow Contextに示されたReport Directory内のファイルのみ参照してください。他のレポートディレクトリは検索・参照しないでください。

**重要: プロダクションコードは作成・変更しないでください。テストファイルのみ作成可能です。**

{{include:instructions/change-contract-traceability}}
{{include:instructions/test-contract-discrimination}}

**テストの境界:**
- 観測可能な契約を基準に作成・更新・削除を判断し、現在のプロンプトにテスト関連の判断基準が提供されている場合はそれも適用する
- 1テスト1概念とし、プロジェクトの既存の命名・配置・helperを使う
- この段階では未実装による失敗を許容するが、実装後も残るテスト欠陥は修正する

{{include:instructions/post-edit-self-scan}}
