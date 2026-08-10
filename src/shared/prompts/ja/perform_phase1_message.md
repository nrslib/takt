<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, hasGitRules, gitRules, editRule, workflowName, workflowDescription,
        hasFallbackNotice, fallbackNotice, hasWorkflowDescription, workflowStructure, iteration, stepIteration, stepName,
        hasReport, reportInfo, phaseNote, hasTaskSection, userRequest, hasPreviousResponse,
        previousResponse, hasUserInputs, userInputs, hasRetryNote, retryNote, hasPrContext, prContext, hasPolicy,
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
- Policy / Knowledge が提供されている場合は、次の順序で確認してください。
  1. 示されたすべての Source Path を特定する
  2. 各 Source Path を先頭から EOF まで読む。1回の表示が途中で切れる場合は範囲を分け、EOF に到達するまで続きを読む。固定範囲の1回だけで読了扱いにしない
  3. 示された Source Path をこの実行の正本として扱う。別の checkout、スキル、同名ファイル、記憶上の内容で代替しない
  4. すべてのファセットとセクションを、元要件、変更する観測可能な契約、境界、実在する影響経路に対して `適用 / 非適用 / 要追加確認` に分類する
- 作業中に新しい事実が判明した場合だけ分類を更新してください。`要追加確認` は判断に必要な証拠の探索へ進め、`適用` だけを finding・編集判断へ反映してください。
- Persona は役割、Instruction は手順、Knowledge は判断材料を提供しますが、それ自体は新しい finding・編集の権限ではありません。finding・編集を許可するのは元の要求、変更する観測可能な契約、適用可能な Policy の基準だけです。探索で品質改善の候補を見つけても、それを許可する要求・契約・Policy がなければ finding や編集へ昇格させないでください。
- 全内容を読んだこと自体は、新しい要求、finding、編集範囲を作る権限ではありません。適用項目だけを判断へ反映し、非適用項目を機械的に探索・指摘・実装しないでください。
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

## Instructions
{{instructions}}
{{#if hasQualityGates}}

## Quality Gates
このステップを完了する前に、以下の要件を満たしてください:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

{{policyContent}}
{{/if}}
