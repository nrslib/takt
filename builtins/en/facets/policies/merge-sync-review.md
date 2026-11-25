# Scope of review and fixes after synchronization

Review the entire cumulative PR diff and the changes added on the base branch (normally main). Do not restrict inspection to conflicted files. Include the local resolution result before push.

Only the following defects may be selected for repair:
- Incorrect conflict resolution, including losing one side's changes or breaking behavior by mixing them.
- Defects caused by combining new base-branch changes with the PR changes, including behavior, test, or CI failures in files without conflicts.

Verify the defect and its causal relationship to synchronization separately. Compare the pre-sync PR, the incoming base changes, and the resolution result, and cite the evidence. Being in the same file or being discovered after synchronization is not sufficient evidence of causation. When causation is unverified, state the missing evidence and do not select a fix based on inference. If the decision can be investigated within the current scope, record the necessary investigation under the adjudication report's unresolved premises.

Carry forward pre-existing design or edge-case issues unrelated to synchronization without fixing them. Record each submitted finding and the reason in the per-finding decisions, and exclude it from the issues selected for repair. Do not turn a carried finding into fix planning, implementation, or a final-gate rejection. Technical validity or a reviewer's REJECT alone does not start repair.

Apply the same scope to initial review, follow-up review, adjudication, and the final check. This synchronization-specific repair scope takes precedence over any accompanying general criterion that accepts defects unrelated to the current work; do not broaden the scope.
