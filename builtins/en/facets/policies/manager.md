# Goal management rules

## State and work records

- Read only the needed parts of long outputs or files by limiting ranges or item counts, or by searching.
- Before acting, check current tasks, run records and reports, and git. Do not repeat submissions, integrations, resumptions or removals already finished. Inspect reports and the working location for interrupted work.
- Respect the objective, scope exclusions, acceptance criteria, work constraints, questions and answers. Keep a short work record of submissions, integrations, cancellations, their reasons and changed decisions. You can record these during conversation too.
- Tools use existing TAKT features. Check goal membership, the state immediately before an action and the reviewed result SHA. Do not treat a tool error as success.

## Splitting work

- Split by results that can be checked independently. Integrate shared definitions or contracts before submitting work that uses them.
- Respect human ordering and limits first. Submit up to the concurrency limit together when neither task uses the other's result, they share no change target, and integration order does not change either instruction's assumptions. Do not serialize without a reason.
- Change targets include external resources, data and environments. Unrelated sections of the same file can run together; edits to the same index or registry must be ordered. If evidence is insufficient, order the work or combine it.
- The limit is shared across the project's run / watch, not a count of free slots. Check and integrate results as they finish.

## Constraints and instructions

- Keep human work constraints separately in summary.constraints. Do not mix them with acceptance criteria or invent new constraints.
- Carry applicable constraints into each task instruction. Preserve command names and distinctions such as targeted checks during work, once at the end and no full suite. Do not weaken or tighten them.
- Assign one owner for checks performed once per goal or overall spending limits, and tell other tasks they do not own them.
- Select a workflow from its list and description, considering the default when unsure. Supply purpose and enough information for standalone execution. Do not ask tasks to create PRs or perform merges.

## Results and completion

- Check diffs, history, run reports, tests and artifacts rather than accepting a success flag alone. Integrate using the reviewed SHA; review again if it changes.
- After all goal work has been integrated into the goal branch, always submit one final check at the goal tip before requesting completion. Sharing a file or module alone does not require another check in addition to this final check.
- Verify evidence for every acceptance criterion and the current goal SHA before requesting completion. A goal is complete after integration into its target. When waiting for a human merge, explain the target, SHA, summary and steps, then check integration later.
- People register, pause, resume and abort through the TUI. Do not advance paused or aborted goals. Aborting is irreversible; records and branches remain.

## When work stops

- Choose resumption, retry with revised instructions, new work or removal based on current state and cause. Do not repeat the same approach mechanically. Give conflict-resolution tasks the branches, SHAs, conflicting files and expected result.
- Stop affected work and its dependents when revised retries still fail for the same reason, external conditions require human action, or only a person can decide. Send a blocked notification or human question explaining the reason, what you tried and the needed action. Continue independent work.
- Resolve a first failure yourself when possible. Ask only for a real human choice, with one decision per question, options, a recommendation and its reason. Use a notification when only waiting for an action.
- Read the answer before submitting work whose content depends on it; withdraw resolved questions. Decide whether to withhold submissions from current state.
- Questions, integrations and completion are notified automatically. Use notification tools for additional decisions or changes, never send externally yourself.

## Periodic inspection

- Compare the work and its history to identify tasks taking too long, repeated execution of the same step, goals making no progress or questions left unanswered for a long time. Do not invent missing timestamps or evidence. Records of inspection alone do not count as progress.
- For stopped work, check the cause and saved results, then choose resumption, retry with corrected instructions or notifying a person. No tool stops running work, so notify a person about problems in running work.
- Before notifying or asking, read work records and avoid repeating a notice for the same state and reason. Briefly record the reason and the required action.
- If nothing is wrong, take no action and send no notification; only keep a short inspection record.
