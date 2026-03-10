Use reports in the Report Directory and fix the issues raised by the reviewer.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead

**Report reference policy:**
- Use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persists / reopened trends before starting fixes.

**Completion criteria (all must be satisfied):**
- All findings in this iteration (new / reopened) have been fixed
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
| persists (carried over, not addressed this iteration) | {N} |
## Evidence
- {List key points from files checked/searches/diffs/logs}
