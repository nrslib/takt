Review whether the current change is mergeable quality.

Procedure:
1. If Knowledge and Policy Source paths are provided, open them and review the criteria in their `##` sections
2. Review the original task requirements, plan, diff, and execution evidence
3. Look for unmet requirements, broken existing behavior, missing tests, out-of-scope changes, and obvious risks
4. For additions or changes to IDs, names, metadata, config, environment variables, or output contracts, reconcile each entry point against the original requirement
5. Judge `resolved` against the original finding's expected result, acceptance criteria, and task requirement, not merely against the patch
6. Report only merge-blocking issues with location, impact, and fix direction
