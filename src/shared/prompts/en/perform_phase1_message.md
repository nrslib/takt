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
## Execution Context
- Working Directory: {{workingDirectory}}
{{#if hasFallbackNotice}}

{{fallbackNotice}}
{{/if}}

## Execution Rules
{{#if hasGitRules}}{{gitRules}}
{{/if}}
- **Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.
{{#if editRule}}- {{editRule}}
{{/if}}{{#if hasWorkflowRulesAfterExecution}}
{{workflowRulesNoticeAfterExecution}}
{{workflowRulesAfterExecution}}
{{/if}}
## Judgment Rules

- Base judgments and outputs on facts verified from files, command outputs, and actual code — not on guesses. Do not write "probably ..." or "should be ..." for unconfirmed claims. Mark unconfirmed items explicitly as "unconfirmed".
- When reference material identifies its original file, read that file from beginning to end. If a display is truncated, continue reading it. Do not substitute another checkout, a same-named file, or remembered content.
- Limit findings and edits to work whose necessity follows from the original request, the observable contract being changed, or an actual impact path. Do not expand into unrelated quality improvements discovered during exploration.
- Session memory degrades as the session grows (context rot). Even if you read a file earlier in this session, re-read it immediately before using it as a basis for judgment or output. Re-run a command only when the role and instructions allow that execution; otherwise, re-read the supplied recorded output. Do not rely on memory like "I already read this" or "I checked this before".
- Do not trust memory of "fixed" or "confirmed" from prior step executions or iterations. Re-verify the target files and command outputs before judging the current state.
{{#if hasKnowledge}}

## Reference Material
The following domain-specific information may inform the work. If it is truncated, inspect the identified original file before deciding.

{{knowledgeContent}}
{{/if}}

## Execution Context
{{#if workflowName}}- Workflow: {{workflowName}}
{{/if}}{{#if hasWorkflowDescription}}- Description: {{workflowDescription}}

{{/if}}{{#if workflowStructure}}{{workflowStructure}}

{{/if}}- Iteration: {{iteration}}(workflow-wide)
- Step Iteration: {{stepIteration}}(times this step has run)
- Step: {{stepName}}
{{#if hasReport}}{{reportInfo}}

{{/if}}
{{#if hasRetryNote}}

## Retry Note
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
{{/if}}## Work
{{instructions}}
{{#if hasQualityGates}}

## Completion Requirements
Before completing this step, ensure the following requirements are met:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

{{policyContent}}
{{/if}}
