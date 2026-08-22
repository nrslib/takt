<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: reportContent, criteriaTable, outputList, hasAppendix, appendixContent, structuredOutput
  builder: StatusJudgmentBuilder
-->
{{#if structuredOutput}}
**Review is already complete. Evaluate the report below and determine which numbered rule (1-based) best matches the result.**
{{else}}
**Review is already complete. Output exactly one tag corresponding to the judgment result shown in the report below.**
{{/if}}

{{reportContent}}

## Decision Criteria

{{criteriaTable}}

{{#if structuredOutput}}

## Task

Evaluate the report against the criteria above. Return the matched rule number (1-based integer) and a brief reason for your decision.
{{else}}

## Output Format

**Output the tag corresponding to the judgment shown in the report in one line:**

{{outputList}}
{{/if}}
{{#if hasAppendix}}

### Appendix Template
{{appendixContent}}
{{/if}}
