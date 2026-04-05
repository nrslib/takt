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
## Execution Context
- Working Directory: {{workingDirectory}}

## Execution Rules
- **Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.
- **Do NOT run git add.** Staging is also handled automatically by the system. Untracked files (`??`) are normal.
- **Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.
{{#if editRule}}- {{editRule}}
{{/if}}
Note: This section is metadata. Follow the language used in the rest of the prompt.
{{#if hasKnowledge}}

## Knowledge
The following knowledge is domain-specific information for this step. Use it as reference.
Knowledge may be truncated. Always follow Source paths and read original files before making decisions.

{{knowledgeContent}}
{{/if}}

## Workflow Context
{{#if pieceName}}- Workflow: {{pieceName}}
{{/if}}{{#if hasPieceDescription}}- Description: {{pieceDescription}}

{{/if}}{{#if pieceStructure}}{{pieceStructure}}

{{/if}}- Iteration: {{iteration}}(workflow-wide)
- Step Iteration: {{movementIteration}}(times this step has run)
- Step: {{movement}}
{{#if hasReport}}{{reportInfo}}

{{phaseNote}}{{/if}}
{{#if hasRetryNote}}

## Retry Note
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
Before completing this step, ensure the following requirements are met:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

## Policy
The following policies are behavioral standards applied to this step. You MUST comply with them.
Policy is authoritative. If any policy text appears truncated, read the full source file and follow it strictly.

{{policyContent}}
{{/if}}
