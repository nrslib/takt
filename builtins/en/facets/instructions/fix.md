When a Finding Contract ledger summary / `findings-ledger.json` is available, use it as the primary source and fix the issues it tracks.
When no ledger is available, use reports in the Report Directory and fix the issues raised by the reviewer.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead

**Report reference policy:**
- When a parseable Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the single authoritative source for deciding what to fix.
- Fix only open ledger findings whose lifecycle is `new`, `persists`, or `reopened`.
- Do not fix ledger findings whose status / lifecycle is `resolved` or closed.
- Use `findings[].rawFindingIds` only as supporting evidence to reach raw finding details and individual reviewer reports; they are not an alternative source of truth.
- When no ledger is available, use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persists / reopened trends before starting fixes.

**Completion criteria (all must be satisfied):**
- All open findings in this iteration (`new` / `persists` / `reopened`) have been fixed
- Potential occurrences of the same `family_tag` have been fixed simultaneously (no partial fixes that cause recurrence)
- At least one regression test per `family_tag` has been added (mandatory for config-contract and boundary-check findings)
- Findings with the same `family_tag` from multiple reviewers have been merged and addressed as one fix

**Important**: After fixing, run the build (type check) and tests.

**Required output (include headings)**
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
