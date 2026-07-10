When a Finding Contract ledger summary / `findings-ledger.json` is available, use it as the primary source and fix the issues it tracks.
When no ledger is available, use reports in the Report Directory and fix the issues raised by the reviewer.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead
- When a ledger is available: dispute a finding only when it contradicts the current code, or is structurally unresolvable within this step's responsibility. Do not pretend to fix it; state a formal dispute under `## Disputed Findings` with concrete counter-evidence and file:line references (follow the format in the Finding Contract instructions). A dispute is pending adjudication — it does not mean resolved or waived
  - Do not cite transient tool failures, task difficulty, or uncertainty as grounds for a dispute
  - Only cite a "deliberate trade-off" when you have evidence of an existing spec or a user decision
- When no ledger is available, the dispute mechanism does not exist, so do not use it. For findings you cannot fix, do not claim you fixed them; note them as blockers in the work results

**Report reference policy:**
- When a parseable Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the single authoritative source for deciding what to fix.
- Fix only open ledger findings whose lifecycle is `new`, `persists`, or `reopened`.
- Do not fix ledger findings whose status / lifecycle is `resolved` or closed.
- Use `findings[].rawFindingIds` only as supporting evidence to reach raw finding details and individual reviewer reports; they are not an alternative source of truth.
- When no ledger is available, use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persists / reopened trends before starting fixes.

**Completion criteria (all must be satisfied):**
- When a ledger is available: every open finding in this iteration (`new` / `persists` / `reopened`) has been either fixed or disputed under `## Disputed Findings` with evidence. These are the only two valid outcomes; leave no finding in neither state
- When no ledger is available: every finding you could fix has been fixed, and findings you could not fix are noted as blockers in the work results rather than claimed as fixed
- For findings you fixed, potential occurrences of the same `family_tag` have been fixed simultaneously (no partial fixes that cause recurrence)
- For findings you fixed where the code defect can be verified by an automated test at the appropriate layer, at least one regression test per `family_tag` has been added (mandatory for config-contract and boundary-check findings). When a meaningful automated test cannot be created, state the reason and the verification steps taken (commands run and results) in the work results. Do not satisfy this criterion with a meta-test such as asserting a file exists. Do not write tests for findings you disputed
- Findings with the same `family_tag` from multiple reviewers have been merged and addressed as one fix

**Important**: After fixing, run the build (type check) and tests.

**Required output (include headings)**
If you disputed any findings, include `## Disputed Findings` (follow the format in the Finding Contract instructions).
## Work results
- {Summary of actions taken}
## Changes made
- {Summary of changes}
## Build results
- {Build execution results}
## Test results
- {Test command executed and results}
## Convergence gate
| Metric | Count |
|--------|-------|
| new (fixed in this iteration) | {N} |
| reopened (recurrence fixed) | {N} |
| persists (carried over, fixed in this iteration) | {N} |
## Evidence
- {List key points from files checked/searches/diffs/logs}
