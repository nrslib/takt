<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase2_message
  phase: 2 (report output)
  vars: workingDirectory, hasTask, task, hasGitRules, gitRules, reportContext, hasLastResponse, lastResponse,
        hasReportOutput, reportOutput, hasOutputContract, outputContract, structuredPublication
  builder: ReportInstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}

## 実行ルール
{{#if hasGitRules}}{{gitRules}}
{{/if}}
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
- **プロジェクトのソースファイルを変更しないでください。**
{{#if structuredPublication}}- **以下で指定する Finding Contract の結合 publication 応答を返してください。** TAKT は `reportContent` を抽出し、その完全に同じバイト列をレポートファイルへ保存します。自分でレポートファイルを書き込まないでください。
{{else}}- **レポート内容のみを回答してください。**
- **TAKT があなたの回答本文をレポートファイルに保存します。** 自分でレポートファイルを書き込まないでください。
{{/if}}
- **Report Directory内のファイルのみ使用してください。** 他のレポートディレクトリは検索/参照しないでください。

## Workflow Context
{{reportContext}}
{{#if hasTask}}

## Original Task Context

以下はこのワークフローに与えられた元のタスクです。要求の正本として使用してください:

{{task}}
{{/if}}
{{#if hasLastResponse}}

## Previous Work Context
以下はPhase 1（本来の作業）の出力です。レポート生成の文脈として使用してください:

{{lastResponse}}
{{/if}}

## Instructions
{{#if structuredPublication}}以下の Finding Contract 結合 publication schema に一致する構造化オブジェクトを、ちょうど1つ回答してください。`reportContent` には完全なレポート本文を含め、`rawFindings` は必ずその同じレポートからのみ抽出してください。構造化オブジェクトの外側に散文・ステータスタグ・コメントを出力しないでください。このフェーズではツールは使えません。
{{else}}
あなたが今行った作業の結果をレポートとして回答してください。**このフェーズではツールは使えません。レポート内容をテキストとして直接回答してください。**
**レポート本文のみを回答してください（ステータスタグやコメントは禁止）。Writeツールやその他のツールは使用できません。**
{{/if}}
{{#if hasReportOutput}}

{{reportOutput}}
{{/if}}
{{#if hasOutputContract}}

{{outputContract}}
{{/if}}
