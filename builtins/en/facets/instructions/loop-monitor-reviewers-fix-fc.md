The review → fix loop has repeated {cycle_count} times.

When a Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the primary source.
When no ledger is available, review the latest reports in the Report Directory and determine whether this loop is healthy (converging) or unproductive (diverging, oscillating, or stalled).

**First establish the observation point:**
- This monitor can run immediately after a fix completes, before any post-fix review exists. When a fix reports addressing a finding after its latest review and no later review evidence exists, that finding is awaiting post-fix verification, not repeating or stalled. Include this state under the healthy / progress option, except for the stalled provisionals described below.
- Do not treat an open ledger status alone as a failed fix or delayed ledger update. Classify a finding as persistent / reopened only when review evidence after the relevant fix confirms the same finding again.

**Judgment criteria:**
- When a parseable Finding Contract ledger exists, treat its `findings` / `conflicts` as authoritative and individual reports as supporting evidence.
- When the ledger is incomplete, follow it for mapped findings and treat unmapped raw findings as candidates awaiting findings-manager reconciliation.
- When the ledger is absent, unreadable, or unparseable, use the latest review reports in the Report Directory as primary evidence.
- Check whether the same finding_id persists across multiple post-fix reviews.
  - Awaiting post-fix review → healthy (continue normal verification)
  - A post-fix review reconfirms the same finding_id → candidate unproductive repetition
  - Previous findings resolve and a different finding appears as new → healthy as a rule
  - However, as soon as a different branch with the same `family_tag` as a recently resolved finding appears as new, count it as unproductive partial-fix recurrence. If the family continues branch by branch, decide whether a replan that fixes all branches together can break the loop.
- Only when a post-fix review still conflicts with the current code should you consider a dispute (dispute → manager adjudication → waive) as a way forward. Do not choose dispute or replanning merely because a finding remains open before post-fix review.
- Check whether the number of new / reopened findings is decreasing overall.

Choose a stop outcome only when neither fixing, replanning, nor disputing can break the deadlock.

**When the engine-injected "Findings state" section is present, always consult it:**
- It lists the open provisional findings blocking completion (findings.open.count == 0), each with its stalled manager-round count and settlement path (later clean evidence / the manager's dismissDecisions).
- When dismissable provisionals, or provisionals whose only settlement path is later clean evidence, stall across multiple rounds, classify the loop as unproductive even if resolved counts grow; do not choose healthy continuation, and select an available adjudication or stop route.
