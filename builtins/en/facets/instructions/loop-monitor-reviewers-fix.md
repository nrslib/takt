The review → fix loop has repeated {cycle_count} times.

Review the latest review and fix reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging, oscillating, or stalled).

**First establish the observation point:**
- This monitor can run immediately after a fix completes, before any post-fix review exists. When a fix reports addressing an issue after its latest review and no later review evidence exists, that issue is awaiting post-fix verification, not repeating or stalled. Include this state under the healthy / progress option.
- When no fix reports addressing the issue, do not infer that the loop is healthy merely because no post-fix review exists.

**Judgment criteria:**
- **Fix progress:** Use fix reports, current code, and post-fix reviews to verify that each prior open finding's acceptance criteria are satisfied. Repetition of the same `finding_id`, root cause, or acceptance criterion after a fix means implementation is incomplete.
- **Report convergence:** Compare completed review rounds and check whether valid new structural or contract findings keep being added. Even when earlier findings resolve, this means the review report has not converged.
- A new finding from a different `family_tag` is not inherently healthy or unproductive. Inspect its content, impact scope, and review round.
- The loop may be converging when new findings are limited to a finite set of local issues and the unreviewed structural or contract surface is not expanding.
- Compare fix units and acceptance evidence in the fix report with the current code to verify that target findings are actually closed.
- When a post-fix review conflicts with the current code, do not repeat the same fix; choose among the available verification, recovery, or stop options.
- Treat counts as supporting information and judge fix progress separately from report-content convergence.

Choose a stop outcome only when implementation is incomplete or the report has not converged and no available action can break the deadlock.
