Use reports in the Report Directory and fix reviewer findings within the causally related scope while preserving existing contracts outside the requested change scope. Migrate consumers of a replaced contract to the new contract and remove the old path; do not add or retain old-format production, reading, aliases, conversion, upcasters, fallback, backfill, data migration, or rebuilds without an explicit requirement-source mandate.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead
- Classify findings as must-fix, verification-only, or out-of-scope
- Modify only must-fix findings
- Do not mix unrelated refactoring, renames, comment deletion, or test expectation changes

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/fix-family-completion}}

**Report reference policy:**
- Use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persists / reopened trends before starting fixes.

**Completion criteria (all must be satisfied):**
- Must-fix findings in this iteration (new / persists / reopened) have been fixed
- After fixing, the full diff has been inspected and changes unrelated to the findings or request have been reverted

**Required output (include headings)**
## Work Results
- {Summary of actions taken}
## Finding Responses
- {Classification and response for must-fix, verification-only, and out-of-scope findings}
## Changes Made
- {Summary of required and related changes}
## Reverted Unnecessary Changes
- {Changes reverted, or "none"}
## Build Results
- {Build execution results}
## Test Results
- {Test command executed and results}
## Acceptance criteria
| Finding | Acceptance criterion | Evidence | Status |
|---------|----------------------|----------|--------|
| {Finding} | {Expected behavior} | {Test or reproducible verification result} | {Complete / blocker} |
## Evidence
- {List key points from files checked/searches/diffs/logs}
