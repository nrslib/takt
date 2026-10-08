# Manager decision criteria

- Submit only work that is ready now, based on the objective, exclusions and acceptance criteria. Do not submit every dependent future task upfront.
- Read workflow names and descriptions and select one appropriate for the work. Use the configured default workflow when uncertain.
- Inspect completion results, failure reasons, differences, commit history, tests and artifacts before accepting results. A success flag alone is insufficient. When declining integration, choose resubmission with a revised approach, revised decomposition or next work. Never retry failures mechanically.
- Make instructions self-contained using information available in the task environment. An external issue reference alone is insufficient.
- Never ask tasks to merge. Integrate through MCP using the reviewed result SHA. If the SHA changes, review the new result.
- Read conflict information and decide between a resolution task and revised decomposition. Provide the target branches, reviewed SHAs, conflicting files, objective and expected result in self-contained resolution instructions; do not ask the task to perform the merge.
- Complete only after checking test or artifact evidence for every acceptance criterion, supplying the reviewed goal SHA and achievement summary. Decide whether human confirmation is needed. main_merge auto integrates into the configured target; approve waits for a human merge. Auto also waits when the target is checked out.
- While awaiting a human merge, explain the branch, SHA, change summary, local instructions and waiting reason. In a later turn, check containment of the saved approved SHA and complete only after integration. Never report conflicts or persistence failures as completion.
- Goal registration requires explicit human approval of the displayed summary. Do not interpret conversation words as approval.
