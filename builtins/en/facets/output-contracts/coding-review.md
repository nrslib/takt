```markdown
# Coding Review

## Result: APPROVE / REJECT

## Summary
{Summarize the review result in 1-2 sentences}

## Contract Entry Check
Fill this when the diff adds or changes IDs, names, metadata, config, environment variables, or output contracts.

| Entry / Path | Original Requirement | Implementation Evidence | Test Evidence | Judgment | Exception / Unverified Evidence |
|--------------|----------------------|--------------------------|---------------|----------|---------------------------------|
| {normal entry / derived condition / validation / evaluation / output / re-injection, etc.} | {Requirement} | `src/file.ts:42` | `src/file.test.ts:10` | ✅/❌/⚠️ | {none / evidence} |

## Non-Finding Concerns
| Item | Location | Classification | Evidence for Not Making a Finding |
|------|----------|----------------|-----------------------------------|
| {Concern, or "none"} | `src/file.ts:42` | false_positive / overreach / outside_contract_jurisdiction / no_issue_after_verification | {Evidence} |

## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Severity | Location | Issue | Impact | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|----------|-------|--------|---------------------|----------------------------------|----------------|
| 1 | CODE-NEW-src-file-L42 | bug | High / Medium / Low | `src/file.ts:42` | {Issue} | {Impact} | {accepted_family_unvisited_consumer / remediation_regression / direct_acceptance_criterion_violation / required_consumer_migration for follow-up; not applicable for initial review; reject every other value} | {Independent evidence explaining why the initial review omitted this follow-up finding; not applicable for initial review} | {Fix suggestion} |

For a follow-up finding, `Authorization Basis` must be exactly one of the four listed values; reject every other value. `Reason Absent from Initial Round` is an independent factual explanation, never another authorization value.

`persists` is limited to an unresolved finding that the latest `review-resolution.md` adjudicates as `actionable`, or that has not yet been adjudicated. A finding adjudicated as `out_of_scope`, `overreach`, `false_positive`, `no_issue_after_verification`, or `duplicate` with its canonical finding consolidated must not appear in `persists`.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | CODE-PERSIST-src-file-L77 | regression | `src/file.ts:77` | `src/file.ts:77` | {Unresolved issue} | {Fix suggestion} |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| CODE-RESOLVED-src-file-L10 | {Original finding acceptance criteria} | Resolved at `src/file.ts:10` |

## Findings adjudicated out of scope
| finding_id | Latest Disposition | Adjudication Evidence |
|------------|--------------------|-----------------------|
| {finding_id} | out_of_scope / overreach / false_positive / no_issue_after_verification / duplicate | `review-resolution.md` disposition and evidence |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Immediately Preceding Adjudication | Reopening Basis (a-d) | New Evidence | Issue | Fix Suggestion |
|---|------------|------------|------------------------------------|-----------------------|--------------|-------|----------------|
| 1 | CODE-REOPENED-src-file-L55 | bug | `review-resolution.md`: previously resolved | d | `src/file.ts:55` | {Reopened issue} | {Fix suggestion} |

`reopened` requires explicitly citing the immediately preceding adjudication and showing one of: (a) requirements or acceptance criteria changed after that adjudication; (b) new concrete evidence satisfies blocking conditions that adjudication found missing; (c) the current code disproves a factual premise of that adjudication; or (d) remediation reintroduced the same issue. Remeasuring the same event, adding samples, or rephrasing severity is not a basis for `reopened`.

## Verification Evidence
- Diff review: {What was checked}
- Build: {Result, or state unverified}
- Tests: {Result, or state unverified}

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge section checked | Evidence in the diff (`file:line` or "none") |
|----------------------------------|----------------------------------------------|
| {section name} | {evidence} |

## Rejection Gate
- REJECT only when at least one finding exists in `new` with a valid `Authorization Basis`, `persists` under its adjudication-bound definition, or `reopened` with a valid basis (a-d)
- Findings adjudicated out of scope do not count toward REJECT
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary plus Verification Evidence, Contract Entry Check, Re-scan Evidence (from the second iteration onward), and Non-Finding Concerns when needed
- REJECT: Include every verified finding row and aggregate locations with the same cause
- Include findings adjudicated out of scope whenever the latest resolution contains findings with any of the listed dispositions
