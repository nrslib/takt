Use reports in the Report Directory and fix reviewer findings within the causally related scope while preserving existing contracts outside the requested change scope.

**Fix principles:**
- When a finding includes a "suggested fix", follow it rather than inventing your own workaround
- Fix the target code directly. Do not deflect findings by adding tests or documentation instead
- Determine from the request, current code, and evidence which reported problems require a change and which only require verification
- Modify only the code needed to resolve the confirmed problems
- Do not mix unrelated refactoring, renames, comment deletion, or test expectation changes

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/repair-path-check}}

{{include:instructions/post-edit-self-scan}}

**Report reference policy:**
- Use the latest review reports in the Report Directory as primary evidence.
- Past iteration reports are saved as `{filename}.{timestamp}` in the same directory (e.g., `architect-review.md.20260304T123456Z`). For each report, run Glob with a `{report-name}.*` pattern, read up to 2 files in descending timestamp order, and understand persistence or recurrence trends before starting fixes.

**Completion criteria (all must be satisfied):**
- Every reported problem that requires a change has been resolved
- After fixing, the full diff has been inspected and changes unrelated to the findings or request have been reverted

Record the decisions, changes, reverted unrelated edits, and verification evidence in the requested format.
