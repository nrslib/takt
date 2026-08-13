The review → fix loop has repeated {cycle_count} times.

Review the latest review and fix reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging, oscillating, or stalled).

{{include:instructions/fix-plan-validity}}
{{include:instructions/invariant-recurrence}}

**First establish the observation point:**
- Use report chronology to determine whether a verifier or review ran after the latest fix. If one did, treat that latest report as authoritative evidence and compare its `incomplete` reasons, unmet acceptance criteria, and evidence changed by each retry. Repeated verifier results with the same reason and evidence indicate a stall.
- If a fix just completed and neither a verifier nor a post-fix review exists yet, an issue reported as addressed after its latest review is awaiting post-fix verification rather than repeating or stalled. Include this state under the healthy / progress option.
- When no fix reports addressing the issue, do not infer that the loop is healthy merely because no later verification report exists.

**Judgment criteria:**
- **Fix progress:** Use fix reports, current code, and post-fix reviews to verify that each prior open finding's acceptance criteria are satisfied. Repetition of the same `finding_id`, root cause, or acceptance criterion after a fix means implementation is incomplete.
- **Report convergence:** Compare completed review rounds and check whether valid new structural or contract findings keep being added. Even when earlier findings resolve, this means the review report has not converged.
- While the monitored cycle has unmet completion obligations, do not select the healthy (converged) option. If progress exists and the next fix is actionable, select the incomplete-but-actionable option.
- Monitor only the recorded recurrence history. When its trigger is true, do not use repair of a different path on each attempt as evidence of health or progress.
- Under the shared invariant-recurrence rules, treat missing or inconsistent history, or an indeterminate trigger whose history cannot be reconstructed, as an artifact deficiency rather than non-recurrence; a complete `indeterminate (first occurrence)` row follows the normal non-triggered outcome. Do not select healthy or progress for an artifact deficiency until a verifier reconstructs the complete register. Use an available verification or recovery outcome for that reconstruction; the artifact deficiency alone does not authorize replanning.
- If the plan already records the invariant, authoritative owner, and applicable enforcement obligation, an omitted or incomplete implementation remains `incomplete`; choose continued structural correction, not replanning.
- Choose an available replanning outcome only when there is evidence of a plan deficiency under the shared fix-plan-validity rules. Recurrence alone is not evidence that the plan assumptions are deficient.
- A new finding from a different `family_tag` is not inherently healthy or unproductive. Inspect its content, impact scope, and review round.
- The loop may be converging when new findings are limited to a finite set of local issues and the unreviewed structural or contract surface is not expanding.
- Compare fix units and acceptance evidence in the fix report with the current code to verify that target findings are actually closed.
- When a post-fix review conflicts with the current code, do not repeat the same fix; choose among the available verification, recovery, or stop options.
- Treat counts as supporting information and judge fix progress separately from report-content convergence.

Choose a stop outcome only when implementation is incomplete or the report has not converged and no available action can break the deadlock.
