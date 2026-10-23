{{phaseContext}}

<!--
  template: perform_judge_message
  phase: judge (AI-based rule evaluation)
  vars: agentOutput, conditionList
  caller: structuredCaller.evaluateCondition
-->
# Judge Task

You are a judge evaluating an agent's output against a set of conditions.
Read the "Agent Output" section, then determine which condition best matches.

## Agent Output
```
{{agentOutput}}
```

## Criteria
| # | Condition |
|---|-----------|
{{conditionList}}

## Instructions
Judge only what is written in the "Agent Output" section; do not inspect materials outside the output, such as files or code.
Output ONLY the tag `[JUDGE:N]` where N is the number of the best matching condition.
Do not output anything else.
