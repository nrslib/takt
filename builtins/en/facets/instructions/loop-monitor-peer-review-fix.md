Verify the review and fix history and determine whether the loop has demonstrable progress.

The target cycle is [{cycle_steps}], and the monitoring window is its latest {cycle_count} completed cycles from workflow iteration {window_start_iteration} through {window_end_iteration}. The Report Directory is `{report_dir}`.
Use a parseable Finding Contract ledger as authoritative when available; otherwise reconcile chronological reports in that directory with the current code. For direct reports, use the unsuffixed latest version and newest timestamped versions. Under `subworkflows/iteration-*`, aggregate only directories whose encoded iteration is inside the monitoring window. Use the version immediately before the window only to establish its initial open findings. Never count an older resolution as progress in this window.

**Judgment procedure:**
1. Establish the monitoring window from those report versions. If the required versions are unavailable, choose Insufficient evidence.
2. For every finding open at the start of the monitoring window, verify whether the current code satisfies its original expected result.
3. Accept `resolved` only with code evidence that satisfies the original expected result, not merely because a patch exists.
4. For every `new` / `reopened` finding, verify causality to a fix in the monitoring window from changed lines and behavior.
5. Check whether the same `family_tag` has moved into an unchanged area that was already reviewed.
6. Select the following judgment from lifecycle and causality evidence, not from counts.

- **Verified progress**: At least one previously open finding is fully resolved, every `new` / `reopened` finding is caused by a fix in the monitored period, and there is no repeated finding without a code change, same-family migration, or renewed discovery in unchanged areas.
- **Insufficient evidence**: Missing, corrupt, or contradictory ledger and report history prevents verification of resolution or causality against the code. Do not infer either progress or unproductivity.
- **Unproductive**: No previously open finding is fully resolved, the same finding repeats without a corresponding code change, a same-family location moves, or findings are revealed late in areas untouched by fixes.

The open-finding count is supporting evidence. A flat or increasing count alone is not unproductive, and a decreasing count alone is not progress. Never treat unresolved issues as complete.
