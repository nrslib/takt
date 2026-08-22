<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase1_message
  phase: 1 (main execution)
  vars: workingDirectory, hasGitRules, gitRules, editRule, workflowName, workflowDescription,
        hasFallbackNotice, fallbackNotice, hasWorkflowDescription, workflowStructure, iteration, stepIteration, stepName,
        hasReport, reportInfo, phaseNote, hasTaskSection, userRequest, hasPreviousResponse,
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
Note: This section is metadata. Follow the language used in the rest of the prompt.

## Judgment Rules

- Base judgments and outputs on facts verified from files, command outputs, and actual code — not on guesses. Do not write "probably ..." or "should be ..." for unconfirmed claims. Mark unconfirmed items explicitly as "unconfirmed".
- When Policy or Knowledge is provided, review it in this order:
  1. Identify every Source Path shown
  2. Read each Source Path from the beginning through EOF. If one display stops partway through, split the read into ranges and continue until EOF. A single bounded read does not count as completion
  3. Treat the shown Source Path as authoritative for this execution. Do not substitute another checkout, a skill, a same-named file, or remembered content
  4. Classify every facet and section as `applicable / not applicable / needs more evidence` against the original requirements, changed observable contracts, boundaries, and real impact paths
- Update a classification only when new evidence appears during the task. Use `needs more evidence` only to explore evidence required for the decision, and let only `applicable` items affect findings or edits.
- A Persona provides a role, an Instruction provides a procedure, and Knowledge provides decision material; none of them independently authorizes a new finding or edit. Only the original request, the observable contract being changed, and applicable Policy criteria provide that authority. When exploration discovers a quality-improvement candidate, do not promote it to a finding or edit unless the request, contract, or an applicable Policy authorizes it.
- Reading all provided material does not authorize new requirements, findings, or edits. Apply only applicable sections and do not mechanically investigate, report, or implement non-applicable sections.
- Session memory degrades as the session grows (context rot). Even if you read a file or ran a command earlier in this session, re-read or re-run it immediately before using it as a basis for judgment or output. Do not rely on memory like "I already read this" or "I checked this before".
- Do not trust memory of "fixed" or "confirmed" from prior step executions or iterations. Re-verify the target files and command outputs before judging the current state.
{{#if hasKnowledge}}

## Knowledge
The following knowledge is domain-specific information for this step. Use it as reference.
Knowledge may be truncated. Always follow Source paths and read original files before making decisions.

{{knowledgeContent}}
{{/if}}

## Workflow Context
{{#if workflowName}}- Workflow: {{workflowName}}
{{/if}}{{#if hasWorkflowDescription}}- Description: {{workflowDescription}}

{{/if}}{{#if workflowStructure}}{{workflowStructure}}

{{/if}}- Iteration: {{iteration}}(workflow-wide)
- Step Iteration: {{stepIteration}}(times this step has run)
- Step: {{stepName}}
{{#if hasReport}}{{reportInfo}}

{{phaseNote}}{{/if}}
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
{{/if}}## Instructions
{{instructions}}
{{#if hasQualityGates}}

## Quality Gates
Before completing this step, ensure the following requirements are met:

{{qualityGatesContent}}
{{/if}}
{{#if hasPolicy}}

{{policyContent}}
{{/if}}
