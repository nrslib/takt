<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase2_message
  phase: 2 (report output)
  vars: workingDirectory, hasTask, task, hasGitRules, gitRules, reportContext, hasLastResponse, lastResponse,
        hasReportOutput, reportOutput, hasOutputContract, outputContract
  builder: ReportInstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}

## 実行ルール
{{#if hasGitRules}}{{gitRules}}
{{/if}}
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
- **プロジェクトのソースファイルを変更しないでください。**
- **レポート内容のみを回答してください。**
- **TAKT があなたの回答本文をレポートファイルに保存します。** 自分でレポートファイルを書き込まないでください。
- **Report Directory内のファイルのみ使用してください。** 他のレポートディレクトリは検索/参照しないでください。

## 実行情報
{{reportContext}}
{{#if hasTask}}

## 元の要求

以下はこのワークフローに与えられた元のタスクです。要求の正本として使用してください:

{{task}}
{{/if}}
{{#if hasLastResponse}}

## 作業結果
以下の作業結果をレポート作成に使用してください:

{{lastResponse}}
{{/if}}
{{#if hasCompletionRetryDiagnostic}}

## 見落とし確認の補助情報

以下は確認範囲を判断するための補助情報です。作業結果そのものとして記載しないでください:

{{completionRetryDiagnostic}}
{{/if}}

## 出力内容

上の作業結果を所定の形式でレポートとして回答してください。**この回答ではツールを使わず、レポート内容をテキストとして直接回答してください。**
**レポート本文のみを回答してください（ステータスタグやコメントは禁止）。Writeツールやその他のツールは使用できません。**
{{#if hasReportOutput}}

{{reportOutput}}
{{/if}}
{{#if hasOutputContract}}

{{outputContract}}
{{/if}}
