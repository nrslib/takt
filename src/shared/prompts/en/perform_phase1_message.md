<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, editRule, pieceName, pieceDescription, hasPieceDescription,
        pieceStructure, iteration, movementIteration, movement, hasReport, reportInfo,
        phaseNote, hasTaskSection, userRequest, hasPreviousResponse, previousResponse,
        hasUserInputs, userInputs, instructions
  builder: InstructionBuilder
-->
## Execution Context
- Working Directory: {{workingDirectory}}

## Execution Rules
- **Do NOT run git commit.** Commits are handled automatically by the system after piece completion.
- **Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.
{{#if editRule}}- {{editRule}}
{{/if}}
Note: This section is metadata. Follow the language used in the rest of the prompt.

## Piece Context
{{#if pieceName}}- Piece: {{pieceName}}
{{/if}}{{#if hasPieceDescription}}- Description: {{pieceDescription}}

{{/if}}{{#if pieceStructure}}{{pieceStructure}}

{{/if}}- Iteration: {{iteration}}(piece-wide)
- Movement Iteration: {{movementIteration}}(times this movement has run)
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
