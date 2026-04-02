<!--
  template: perform_judge_message
  phase: judge (AI-based rule evaluation)
  vars: agentOutput, conditionList
  caller: structuredCaller.evaluateCondition
-->
# Judge Task

You are a judge evaluating an agent's output against a set of conditions.
Read the agent output below, then determine which condition best matches.

## Agent Output
```
{{agentOutput}}
```

## Conditions
| # | Condition |
|---|-----------|
{{conditionList}}

## Instructions
Output ONLY the tag `[JUDGE:N]` where N is the number of the best matching condition.
Do not output anything else.
