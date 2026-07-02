# Review Finding Tracking Policy

Handle review finding IDs, lifecycle, reopen decisions, and history tracking consistently.

## Principles

| Principle | Criteria |
|-----------|----------|
| Workflow scope | Finding Contract applies to the whole review workflow, not to individual findings |
| Authoritative ledger | When a ledger is available, it is the authoritative source for tracked findings |
| ID uniqueness | Do not mix different problems under the same `finding_id` |
| Reproducibility | A reopened finding requires reproduction steps, expected vs. actual result, and failing location |
| History first | Determine finding state from report history and ledger, not memory or Previous Response alone |

## Finding Contract Applicability

Treat a workflow as using Finding Contract only when it declares `finding_contract` at workflow level.

| Criteria | Judgment |
|----------|----------|
| Workflow-level `finding_contract` setting exists | Finding Contract workflow |
| Only `findings-ledger.json` exists | Does not enable Finding Contract |
| Only a Finding Contract section exists in instructions | Does not enable Finding Contract |
| Only an `Observed Findings` table exists in the output contract | Does not enable Finding Contract |

## Reporting Findings With Finding Contract

| Criteria | Judgment |
|----------|----------|
| Reviewer allocates a new final `finding_id` | REJECT |
| Reviewer classifies lifecycle as `new` / `persists` / `resolved` / `reopened` | REJECT |
| Reviewer reports observed problems as raw findings | OK |
| Reviewer refers to IDs present in the ledger | OK |
| Reviewer treats IDs absent from the ledger as existing IDs | REJECT |

ID assignment and lifecycle matching belong to the findings-manager and engine.

## Ledger And Report History Precedence

| Situation | Handling |
|-----------|----------|
| Parseable ledger is available | Use the ledger as the authoritative source for tracked findings |
| Ledger exists but is incomplete | Follow mapped findings and treat unmapped raw findings as pending reconciliation |
| Finding Contract workflow has no parseable ledger | Use latest reviews only as supporting evidence for observed raw findings |
| Workflow does not use Finding Contract | Use latest reviews and history as primary evidence, then apply legacy rules |

## Legacy Finding ID Rules

When a workflow does not use `finding_contract` configuration, follow these legacy rules.

- Every issue raised in a REJECT must include a `finding_id`
- If the same issue is raised again, reuse the same `finding_id`
- For repeated issues, set status to `persists` and include concrete evidence that it remains unresolved
- New issues must use status `new`
- Resolved issues must be listed with status `resolved`
- Issues without `finding_id` are invalid. This legacy rule does not apply to Finding Contract workflows
- REJECT is allowed only when there is at least one `new` or `persists` issue
- Before treating a prior finding as resolved, verify that the fix did not introduce a different structural or contract problem

## Reopen Conditions

Reopening a resolved finding requires reproducible evidence.

| Criteria | Judgment |
|----------|----------|
| Reproduction steps, expected vs. actual result, and failing location are all present | reopening allowed |
| Any of those items is missing | invalid as REJECT evidence |
| Reproduction conditions changed | issue a new `finding_id` as a different problem |

## Immutable Meaning Of `finding_id`

Do not mix different problems under the same ID.

- A `finding_id` must refer to one and only one problem
- If problem meaning, evidence, or reproduction conditions change, issue a new `finding_id`
- Rewriting an existing `finding_id` to represent a different problem is prohibited

## Tracking Findings From Previous Reviews

| Criteria | Judgment |
|----------|----------|
| Ledger is usable | Fix only open findings; ignore resolved or closed findings |
| Report history is used | Compare latest result with prior history and do not drop open findings from the new report |
| State is determined from Previous Response alone | REJECT |
| `resolved` is judged only from patch presence | REJECT |
| `resolved` is judged against the original expected result and original requirement | OK |
