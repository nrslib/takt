<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: reportContent, criteriaTable, outputList, hasAppendix, appendixContent, structuredOutput
  builder: StatusJudgmentBuilder
-->
{{#if structuredOutput}}
**Map the judgment result stated in the input below to a rule number (1-based) in the decision criteria.**
{{else}}
**Output exactly one tag corresponding to the judgment result stated in the input below.**
Judge only what is written in the input; do not inspect materials outside the input.
{{/if}}

{{reportContent}}

## Decision Criteria

{{criteriaTable}}

{{#if structuredOutput}}

## Task

- Judge only what is written in the input above. Do not recheck whether its conclusion is correct, read files, code, or test results, or base your decision on problems absent from the input.
- If the input explicitly states a conclusion, select the rule that matches it. A clear statement of the result in the body counts as a conclusion even without a heading.
- If no conclusion is explicitly stated, select the rule that matches the facts written in the input.
- If an explicit conclusion conflicts with statements in the same input (for example, approval despite unresolved findings), do not accept that conclusion as-is; select the rule that matches the stated facts.
- Return the selected rule number and briefly cite the part of the input supporting your decision in reason.
{{else}}

## Output Format

**Output the tag corresponding to the judgment result stated in the input in one line:**

{{outputList}}
{{/if}}
{{#if hasAppendix}}

### Appendix Template
{{appendixContent}}
{{/if}}
