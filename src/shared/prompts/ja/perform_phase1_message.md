<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, hasGitRules, gitRules, editRule, workflowName, workflowDescription,
        hasFallbackNotice, fallbackNotice, hasWorkflowDescription, workflowStructure, iteration, stepIteration, stepName,
        hasReport, reportInfo, hasTaskSection, userRequest, hasPreviousResponse,
        previousResponse, hasUserInputs, userInputs, hasRetryNote, retryNote, hasPrContext, prContext, hasPolicy,
        policyContent, hasKnowledge, knowledgeContent, hasQualityGates, qualityGatesContent,
        hasWorkflowRulesAfterExecution, workflowRulesNoticeAfterExecution, workflowRulesAfterExecution,
        hasWorkflowRulesBeforeInstruction, workflowRulesNoticeBeforeInstruction, workflowRulesBeforeInstruction,
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
{{/if}}{{#if hasWorkflowRulesAfterExecution}}
{{workflowRulesNoticeAfterExecution}}
{{workflowRulesAfterExecution}}
{{/if}}

## 判断ルール

- 判断・出力の根拠は、推測ではなく、ファイル・コマンド出力・実コードで確認した事実に限ってください。確認していないことを「たぶんこう」「〜のはず」と書かないでください。確認できないことは「未確認」と明記してください。
- 参照資料に元ファイルの場所が示されている場合は、そのファイルを先頭から末尾まで確認してください。表示が途中で切れた場合は続きを読むものとし、別の checkout、同名ファイル、記憶上の内容で代替しないでください。
- 指摘や編集は、元の要求、変更する観測可能な契約、実在する影響経路から必要性を確認できるものに限ってください。探索中に見つけた無関係な品質改善へ範囲を広げないでください。
- セッションが長くなると、過去に読んだ内容の正確な記憶は劣化します（context rot）。判断・出力の根拠にするファイル・コマンド出力は、過去に同じセッションで参照したものであっても、判断直前に再読・再実行してください。「すでに読んだから知っている」「前に確認したから大丈夫」という記憶に依存しないでください。
- 過去のステップ実行・iteration での「修正済み」「確認済み」の記憶を信用せず、対象ファイル・コマンド出力を再確認してから状態を判定してください。
{{#if hasKnowledge}}

## 参考資料
以下は判断に利用できるドメイン固有の情報です。内容が省略されている場合は、示された元ファイルを判断前に確認してください。

{{knowledgeContent}}
{{/if}}

## 実行情報
{{#if workflowName}}- ワークフロー: {{workflowName}}
{{/if}}{{#if hasWorkflowDescription}}- 説明: {{workflowDescription}}

{{/if}}{{#if workflowStructure}}{{workflowStructure}}

{{/if}}- Iteration: {{iteration}}（ワークフロー全体）
- Step Iteration: {{stepIteration}}（このステップの実行回数）
- Step: {{stepName}}
{{#if hasReport}}{{reportInfo}}

{{/if}}
{{#if hasRetryNote}}

## 再投入メモ
{{retryNote}}
{{/if}}
{{#if hasPrContext}}

{{prContext}}
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
{{#if hasWorkflowRulesBeforeInstruction}}{{workflowRulesNoticeBeforeInstruction}}
{{workflowRulesBeforeInstruction}}

{{else}}
{{/if}}## 作業内容
{{instructions}}
{{#if hasQualityGates}}

## 完了条件
このステップを完了する前に、以下の要件を満たしてください:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

{{policyContent}}
{{/if}}
