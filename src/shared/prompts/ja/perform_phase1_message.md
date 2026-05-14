<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, hasGitRules, gitRules, editRule, workflowName, workflowDescription,
        hasFallbackNotice, fallbackNotice, hasWorkflowDescription, workflowStructure, iteration, stepIteration, stepName,
        hasReport, reportInfo, phaseNote, hasTaskSection, userRequest, hasPreviousResponse,
        previousResponse, hasUserInputs, userInputs, hasRetryNote, retryNote, hasPolicy,
        policyContent, hasKnowledge, knowledgeContent, hasQualityGates, qualityGatesContent,
        instructions
  builder: InstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}
{{#if hasFallbackNotice}}

{{fallbackNotice}}
{{/if}}

## 実行ルール
{{#if hasGitRules}}{{gitRules}}
{{/if}}
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
{{#if editRule}}- {{editRule}}
{{/if}}

## 判断ルール

- 判断・出力の根拠は、推測ではなく、ファイル・コマンド出力・実コードで確認した事実に限ってください。確認していないことを「たぶんこう」「〜のはず」と書かないでください。確認できないことは「未確認」と明記してください。
- セッションが長くなると、過去に読んだ内容の正確な記憶は劣化します（context rot）。判断・出力の根拠にするファイル・コマンド出力は、過去に同じセッションで参照したものであっても、判断直前に再読・再実行してください。「すでに読んだから知っている」「前に確認したから大丈夫」という記憶に依存しないでください。
- 過去のステップ実行・iteration での「修正済み」「確認済み」の記憶を信用せず、対象ファイル・コマンド出力を再確認してから状態を判定してください。
{{#if hasKnowledge}}

## Knowledge
以下のナレッジはこのステップに適用されるドメイン固有の知識です。参考にしてください。
Knowledge はトリミングされる場合があります。Source Path に従い、判断前に必ず元ファイルを確認してください。

{{knowledgeContent}}
{{/if}}

## Workflow Context
{{#if workflowName}}- ワークフロー: {{workflowName}}
{{/if}}{{#if hasWorkflowDescription}}- 説明: {{workflowDescription}}

{{/if}}{{#if workflowStructure}}{{workflowStructure}}

{{/if}}- Iteration: {{iteration}}（ワークフロー全体）
- Step Iteration: {{stepIteration}}（このステップの実行回数）
- Step: {{stepName}}
{{#if hasReport}}{{reportInfo}}

{{phaseNote}}{{/if}}
{{#if hasRetryNote}}

## 再投入メモ
{{retryNote}}
{{/if}}
{{#if hasTaskSection}}

## User Request
{{userRequest}}
{{/if}}
{{#if hasPreviousResponse}}

## Previous Response
{{previousResponse}}
{{/if}}
{{#if hasUserInputs}}

## Additional User Inputs
{{userInputs}}
{{/if}}

## Instructions
{{instructions}}
{{#if hasQualityGates}}

## Quality Gates
このステップを完了する前に、以下の要件を満たしてください:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

## Policy
以下のポリシーはこのステップに適用される行動規範です。必ず遵守してください。
Policy は最優先です。トリミングされている場合は必ず Source Path の全文を確認して厳密に従ってください。

{{policyContent}}
{{/if}}
