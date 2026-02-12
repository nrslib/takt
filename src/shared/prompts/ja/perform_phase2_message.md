<!--
  template: perform_phase2_message
  phase: 2 (report output)
  vars: workingDirectory, reportContext, hasLastResponse, lastResponse, hasReportOutput, reportOutput,
        hasOutputContract, outputContract
  builder: ReportInstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}

## 実行ルール
- **git commit を実行しないでください。** コミットはピース完了後にシステムが自動で行います。
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
- **プロジェクトのソースファイルを変更しないでください。** レポート内容のみを回答してください。
- **Report Directory内のファイルのみ使用してください。** 他のレポートディレクトリは検索/参照しないでください。

## Piece Context
{{reportContext}}
{{#if hasLastResponse}}

## Previous Work Context
以下はPhase 1（本来の作業）の出力です。レポート生成の文脈として使用してください:

{{lastResponse}}
{{/if}}

## Instructions
あなたが今行った作業の結果をレポートとして回答してください。**このフェーズではツールは使えません。レポート内容をテキストとして直接回答してください。**
**レポート本文のみを回答してください（ステータスタグやコメントは禁止）。Writeツールやその他のツールは使用できません。**
{{#if hasReportOutput}}

{{reportOutput}}
{{/if}}
{{#if hasOutputContract}}

{{outputContract}}
{{/if}}
