**Defect-family completion contract (required):**
1. Complete every in-scope fix unit; do not declare completion after addressing only a subset.
2. Fix an independent local issue directly.
3. For a structural issue, build a completion checklist from the authoritative contract: every invariant, valid example, failing example or boundary value, and participating contract path. Reviewer examples are starting points for discovery, not the complete checklist.
4. Migrate every participating consumer to the new boundary and remove replaced duplicate or obsolete paths.
5. Add an undocumented condition with the same root cause to the current fix unit and fix it now when it does not change the remediation assumptions. Request replanning only when the root cause, target responsibility or source of truth, or task-level design changes.
6. Verify each finding's acceptance criteria and the completion checklist with appropriate happy-path, failure-path, and boundary tests or reproducible evidence.
7. Recheck changed locations and their direct impact paths, and fix newly found independent local issues.
