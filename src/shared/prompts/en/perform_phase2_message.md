<!--
  template: perform_phase2_message
  phase: 2 (report output)
  vars: workingDirectory, reportContext, hasLastResponse, lastResponse, hasReportOutput, reportOutput,
        hasOutputContract, outputContract
  builder: ReportInstructionBuilder
-->
## Execution Context
- Working Directory: {{workingDirectory}}

## Execution Rules
- **Do NOT run git commit.** Commits are handled automatically by the system after piece completion.
- **Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.
- **Do NOT modify project source files.** Only respond with the report content.
- **Use only the Report Directory files listed below.** Do not search or open reports outside that directory.
Note: This section is metadata. Follow the language used in the rest of the prompt.

## Piece Context
{{reportContext}}
{{#if hasLastResponse}}

## Previous Work Context
The following is the output from Phase 1 (your main work). Use this as context to generate the report:

{{lastResponse}}
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
