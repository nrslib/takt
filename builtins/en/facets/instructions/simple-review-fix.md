Use the gathered review context to assess the code quality of the target changes and perform necessary fixes and verification.

1. Read the review target report and repository working instructions to understand the purpose, requirements and scope.
2. Inspect the cumulative local diff against the base. Include synchronization, conflict resolution, staged and unstaged changes; do not rely only on the remote PR diff.
3. Review the changes and affected execution paths using the injected common policies, knowledge and dynamic facets. Do not approve based solely on previous reviews or the author's identity.
4. Fix valid issues within the requested scope, then recheck the cumulative diff including your repairs. Perform review, repair and verification yourself without delegating to other agents.
5. Run project-required verification and checks needed for the changes. Existing evidence may be used only when its target changes and conditions still match.
6. Record reviewed quality, fixes, results, unresolved issues and unverified areas. Distinguish implementation defects from environment-limited verification; do not hide unfinished mandatory work behind approval.
