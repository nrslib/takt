<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, editRule, pieceName, pieceDescription, hasPieceDescription,
        pieceStructure, iteration, movementIteration, movement, hasReport, reportInfo,
        phaseNote, hasTaskSection, userRequest, hasPreviousResponse, previousResponse,
        hasUserInputs, userInputs, hasRetryNote, retryNote, hasPolicy, policyContent,
        hasKnowledge, knowledgeContent, hasQualityGates, qualityGatesContent, instructions
  builder: InstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}

## 実行ルール
- **git commit を実行しないでください。** コミットはピース完了後にシステムが自動で行います。
- **git add を実行しないでください。** ステージングもシステムが自動で行います。新規ファイルが未追跡（`??`）でも正常です。
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
{{#if editRule}}- {{editRule}}
{{/if}}
{{#if hasKnowledge}}

## Knowledge
以下のナレッジはこのムーブメントに適用されるドメイン固有の知識です。参考にしてください。
Knowledge はトリミングされる場合があります。Source Path に従い、判断前に必ず元ファイルを確認してください。

{{knowledgeContent}}
{{/if}}

## Piece Context
{{#if pieceName}}- ピース: {{pieceName}}
{{/if}}{{#if hasPieceDescription}}- 説明: {{pieceDescription}}

{{/if}}{{#if pieceStructure}}{{pieceStructure}}

{{/if}}- Iteration: {{iteration}}（ピース全体）
- Movement Iteration: {{movementIteration}}（このムーブメントの実行回数）
- Movement: {{movement}}
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
このムーブメントを完了する前に、以下の要件を満たしてください:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

## Policy
以下のポリシーはこのムーブメントに適用される行動規範です。必ず遵守してください。
Policy は最優先です。トリミングされている場合は必ず Source Path の全文を確認して厳密に従ってください。

{{policyContent}}
{{/if}}
