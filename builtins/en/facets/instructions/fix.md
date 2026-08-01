When the engine provides a live Finding Contract ledger summary or Finding state, treat that live state as authoritative and fix the issues it tracks. A `findings-ledger.json` file, when present, is only an auxiliary snapshot.
When no live Finding Contract state is available, use reports in the Report Directory and fix the issues raised by the reviewer.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead
- When live Finding Contract state is available: dispute a finding only when it contradicts the current code, or is structurally unresolvable within this step's responsibility. Do not pretend to fix it; state a formal dispute under `## Disputed Findings` with concrete counter-evidence and file:line references (follow the format in the Finding Contract instructions). A dispute is pending adjudication — it does not mean resolved or waived
  - Do not cite transient tool failures, task difficulty, or uncertainty as grounds for a dispute
  - Only cite a "deliberate trade-off" when you have evidence of an existing spec or a user decision
- When no live Finding Contract state is available, the dispute mechanism does not exist, so do not use it. For findings you cannot fix, do not claim you fixed them; note them as blockers in the work results

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/fix-family-completion}}

**Report reference policy:**
- Use the engine-provided live ledger summary / Finding state as the authoritative source for deciding what to fix. Treat `findings-ledger.json` only as an auxiliary snapshot; it must not override live state.
- Fix only open findings whose lifecycle is `new`, `persists`, or `reopened` in the live state.
- Do not fix findings whose status / lifecycle is `resolved` or closed in the live state.
- Use `findings[].rawFindingIds` only as supporting evidence to reach raw finding details and individual reviewer reports; they are not an alternative source of truth.
- When no live Finding Contract state is available, use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persists / reopened trends before starting fixes.

**Completion criteria (all must be satisfied):**
- When live Finding Contract state is available: every open finding in this iteration (`new` / `persists` / `reopened`) has been either fixed or disputed under `## Disputed Findings` with evidence. These are the only two valid outcomes; leave no finding in neither state
- When no live Finding Contract state is available: every finding you could fix has been fixed, and findings you could not fix are noted as blockers in the work results rather than claimed as fixed

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
## Acceptance criteria
| Finding ID | Acceptance criterion | Evidence | Status |
|------------|----------------------|----------|--------|
| {ID} | {Expected behavior} | {Test or reproducible verification result} | {Complete / disputed / blocker} |
## Evidence
- {List key points from files checked/searches/diffs/logs}
