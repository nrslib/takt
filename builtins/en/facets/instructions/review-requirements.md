Review the changes from a requirements fulfillment perspective.

**Review criteria:**
- Whether each requested requirement has been implemented
- Whether implicit requirements (naturally expected behaviors) are satisfied
- Whether changes outside the scope (scope creep) have crept in
- Whether there are any partial or missing implementations


**Design decisions reference:**
Review {report:coder-decisions.md} to understand the recorded design decisions.
- Do not flag intentionally documented decisions as FP
- However, also evaluate whether the design decisions themselves are sound, and flag any problems

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved / reopened`
- If status is `persists`, provide concrete unresolved evidence (file/line)

## Judgment Procedure

1. Read `order.md`, the task body, `plan.md`, and `coder-decisions.md`, then extract the requirements one by one
2. If a sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
   - Do not keep `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, or `read/write` in a single row
3. For each requirement, identify the implementing code (file:line)
4. Classify each requirement as `satisfied / unmet / unverified`
   - Do not mark a row `satisfied` without concrete code evidence
   - Do not mark a row `satisfied` when only part of the cases is covered
5. List out-of-scope changes and judge whether they are justified or unnecessary
6. Reclassify prior findings into `new / persists / resolved / reopened`
7. For each detected issue, classify it as blocking/non-blocking based on the Policy's scope table and judgment rules
8. If there is even one blocking issue in `new`, `persists`, or `reopened`, judge as REJECT
