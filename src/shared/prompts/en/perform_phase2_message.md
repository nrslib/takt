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
## Execution Context
{{reportContext}}
{{#if hasTask}}

## Original Request

The following is the original task given to this workflow. Treat it as the authoritative source of requirements:

{{task}}
{{/if}}
{{#if hasLastResponse}}

## Work Result
Use the following work result to produce the report:

{{lastResponse}}
{{/if}}
{{#if hasCompletionRetryDiagnostic}}

## Missed-Path Check

The following information is only for deciding what was checked. Do not present it as part of the work result:

{{completionRetryDiagnostic}}
{{/if}}

## Output

Present the work result above in the required report format. **Do not use tools for this response; answer directly with the report text.**
**Respond with only the report content (no status tags, no commentary). You cannot use the Write tool or any other tools.**
{{#if hasReportOutput}}

{{reportOutput}}
{{/if}}
{{#if hasOutputContract}}

{{outputContract}}
{{/if}}
