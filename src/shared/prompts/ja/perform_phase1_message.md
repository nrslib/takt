<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, editRule, pieceName, pieceDescription, hasPieceDescription,
        pieceStructure, iteration, movementIteration, movement, hasReport, reportInfo,
        phaseNote, hasTaskSection, userRequest, hasPreviousResponse, previousResponse,
        hasUserInputs, userInputs, instructions
  builder: InstructionBuilder
-->
## 実行コンテキスト
- 作業ディレクトリ: {{workingDirectory}}

## 実行ルール
- **git commit を実行しないでください。** コミットはピース完了後にシステムが自動で行います。
- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
{{#if editRule}}- {{editRule}}
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
