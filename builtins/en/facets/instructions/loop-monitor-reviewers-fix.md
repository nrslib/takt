The review → fix loop has repeated {cycle_count} times.

Review the latest review and fix reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging, oscillating, or stalled).

{{include:instructions/fix-plan-validity}}
{{include:instructions/invariant-recurrence}}

**First establish the observation point:**
- Use report chronology to determine whether a fix verifier or review ran after the latest fix. If the latest report is fix-verification.md, compare its `incomplete` reasons, unmet verification obligations, and evidence changed by each retry; repeated results with the same reason and evidence indicate a stall. If the latest report is review-resolution.md or another review report, compare finding IDs, dispositions, acceptance criteria, and current evidence instead.
- If a fix just completed and neither a verifier nor a post-fix review exists yet, classify it as awaiting post-fix verification and include it under the healthy / progress option only when the latest fix-report.md records every Completion Obligation for the affected fix unit as `complete` or `not applicable` and records no Open Obligations. A statement that the issue was addressed does not override an incomplete obligation; treat such a report as an incomplete fix.
- When no fix reports addressing the issue, do not infer that the loop is healthy merely because no later verification report exists.

**Judgment criteria:**
- **Fix progress:** Use fix reports, current code, and post-fix reviews to verify that each prior open finding's acceptance criteria are satisfied. Repetition of the same `finding_id`, root cause, or acceptance criterion after a fix means implementation is incomplete.
- **Report convergence:** Compare completed review rounds and check whether valid new structural or contract findings keep being added. Even when earlier findings resolve, this means the review report has not converged.
- While the monitored cycle has unmet completion obligations, do not select the healthy (converged) option. If progress exists and the next fix is actionable, select the incomplete-but-actionable option.
- Monitor only the recorded recurrence history. When recurrence on a different path is `confirmed`, do not use repair of a different path on each attempt as evidence of health or progress.
- Treat missing or inconsistent history, or a row for which whether recurrence on a different path is confirmed cannot be reconstructed and is recorded as `cannot determine`, as an artifact deficiency rather than non-recurrence, and use the same cautious treatment as `confirmed`. A complete `cannot determine (first verification)` row follows the normal `not confirmed` outcome. Do not select healthy or progress for an artifact deficiency until a fix verifier reconstructs the complete register. Use an available verification or recovery outcome for that reconstruction; the artifact deficiency alone does not authorize replanning.
- If the plan already records the invariant, its responsible source (the single responsibility and source that defines the invariant and guarantees it holds), and the applicable enforcement obligation, an omitted or incomplete implementation remains `incomplete`. Do not use a physical code location or file path as identity, and do not treat a file move or split alone as a different invariant. Choose continued structural correction, not replanning.
- Choose an available replanning outcome only when evidence shows that required plan fields, assumptions, remediation boundary, methods, or evidentiary power are missing or inconsistent and a plan change can resolve the deficiency. Recurrence alone is not evidence that the plan assumptions are deficient.
- A new finding from a different `family_tag` is not inherently healthy or unproductive. Inspect its content, impact scope, and review round.
- The loop may be converging when new findings are limited to a finite set of local issues and the unreviewed structural or contract surface is not expanding.
- Compare fix units and acceptance evidence in the fix report with the current code to verify that target findings are actually closed.
- When a post-fix review conflicts with the current code, do not repeat the same fix; choose among the available verification, recovery, or stop options.
- Treat counts as supporting information and judge fix progress separately from report-content convergence.

If the latest reviewer reports from the immediately preceding completed review round all say `APPROVE` and contain no `new`, `persists`, or `reopened` finding, but the same actionable family appears only in the `review-resolution.md` currently present in the Report Directory, and the `fix-verification.md` for the repeated fix includes that family and records the result as `verified`, do not treat the repetition as a normal stall that another review or fix can resolve. Choose the current loop monitor's declared outcome for a loop that another review or fix cannot resolve; do not choose an outcome that directly retries reviewers or the same fix work.

Choose an outcome that does not retry the same review/fix work only when either implementation is incomplete or the report has not converged, and no available action can break the deadlock, or when the resolution-only repetition described above is present. Do not directly retry reviewers or the same fix work for that repetition.
