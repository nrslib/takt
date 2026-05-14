Focus on reviewing **requirements fulfillment**.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues

## Step-Specific Additional Procedure

1. Read `order.md`, the task body, `plan.md`, and `coder-decisions.md`, then extract the requirements one by one
2. If a sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
   - Do not keep `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, or `read/write` in a single row
3. For each requirement, identify the implementing code (file:line)
4. Classify each requirement as `satisfied / unmet / unverified`
   - Do not mark a row `satisfied` without concrete code evidence
   - Do not mark a row `satisfied` when only part of the cases is covered
5. List out-of-scope changes and judge whether they are justified or unnecessary
