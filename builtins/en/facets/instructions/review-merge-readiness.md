# Merge Readiness Review

Review whether the accumulated diff after specialist review is quality-ready to enter a codebase that must be maintained going forward.

Procedure:
1. If Knowledge and Policy Source paths are provided, open them and review the criteria in their `##` sections
2. Review the original task requirements, plan, diff, execution evidence, and prior review reports
3. Look for unmet requirements, broken existing behavior, missing tests, out-of-scope changes, maintainability degradation, and obvious risks
4. List every added or changed ID, name, metadata field, config value, environment variable, output contract, type field, status/discriminant, helper, adapter, and entry point
5. For each listed item, check same-kind usages, mocks, fixtures, factories, test doubles, and persisted/displayed/executed entry points with Grep / Glob / Read, and record the searched terms and files as evidence
6. For side effects or state changes, verify happy path, early return, exception, interruption, and cleanup / rollback paths separately
7. Verify that future maintainers can trace the reason for the change, the affected surface, and the validation path
8. Judge `resolved` against the original finding's expected result, acceptance criteria, and task requirement, not merely against the patch
9. Report only quality or maintainability issues that should block the merge, with location, impact, and fix direction
