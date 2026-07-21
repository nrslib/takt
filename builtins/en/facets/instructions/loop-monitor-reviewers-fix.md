The review → fix loop has repeated {cycle_count} times.

Review the latest review and fix reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging, oscillating, or stalled).

**First establish the observation point:**
- This monitor can run immediately after a fix completes, before any post-fix review exists. When a fix reports addressing an issue after its latest review and no later review evidence exists, that issue is awaiting post-fix verification, not repeating or stalled. Include this state under the healthy / progress option.
- When no fix reports addressing the issue, do not infer that the loop is healthy merely because no post-fix review exists.

**Judgment criteria:**
- Check whether the same issue persists across multiple post-fix reviews.
  - A reported fix awaiting post-fix review → healthy (continue normal verification)
  - A post-fix review reconfirms the same issue → candidate unproductive repetition
  - Previous issues resolve and a different issue appears as new → healthy as a rule
- Compare the fix report with the current code to verify that the fix was actually applied.
- When a post-fix review conflicts with the current code, do not repeat the same fix; choose among the available verification, recovery, or stop options.
- Check whether the number of new or recurring issues is decreasing overall.

Choose a stop outcome only when the same problem repeats after post-fix review and no available action can break the deadlock.
