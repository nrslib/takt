<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase2_message
  phase: 2 (report output)
  vars: workingDirectory, hasTask, task, hasGitRules, gitRules, reportContext, hasLastResponse, lastResponse,
        hasReportOutput, reportOutput, hasOutputContract, outputContract
  builder: ReportInstructionBuilder
-->
## Execution Context
- Working Directory: {{workingDirectory}}

## Execution Rules
{{#if hasGitRules}}{{gitRules}}
{{/if}}
- **Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.
- **Do NOT modify project source files.**
- **Only respond with the report content.**
- **TAKT will save your response body to the report file.** Do not write the report file yourself.
- **Use only the Report Directory files listed below.** Do not search or open reports outside that directory.
Note: This section is metadata. Follow the language used in the rest of the prompt.

## Workflow Context
{{reportContext}}
{{#if hasTask}}

## Original Task Context

The following is the original task given to this workflow. Treat it as the authoritative source of requirements:

{{task}}
{{/if}}
{{#if hasLastResponse}}

## Previous Work Context
The following is the output from Phase 1 (your main work). Use this as context to generate the report:

{{lastResponse}}
{{/if}}
{{#if hasReviewCompletionDiagnostic}}

## Review Completion Diagnostic

This diagnostic is only context for this Phase 2 report. Do not convert it into a finding or status, and do not claim that it was part of the reviewer response:

{{reviewCompletionDiagnostic}}
{{/if}}

## Instructions

Respond with the results of the work you just completed as a report. **Tools are not available in this phase. Respond with the report content directly as text.**
**Respond with only the report content (no status tags, no commentary). You cannot use the Write tool or any other tools.**
{{#if hasReportOutput}}

{{reportOutput}}
{{/if}}
{{#if hasOutputContract}}

{{outputContract}}
{{/if}}
