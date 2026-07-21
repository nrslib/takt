The replanning loop (plan → write tests → implement → review → fix → plan) has repeated {cycle_count} times.

This loop is by design: whenever the fixer declares it cannot proceed, control returns to plan.
Your job is to judge whether replanning is moving the blocker toward resolution or repeating the same dead end.

If a Finding Contract ledger summary / `findings-ledger.json` exists, treat the consolidated ledger as the
primary source; otherwise inspect the latest plan and review reports in the Report Directory.

**Check first:**
This monitor fires on the step-name sequence alone, so it can trigger right after a fix that ended
normally with fixes complete. That is not a dead end - choose the normal transition back to review.

**Criteria:**
- Does the latest plan show a new decomposition or a different approach to the previously stated blocker?
  - Plans that are substantively identical each round → unproductive (same wall, same run-up)
  - The work breakdown changes rather than rephrasing the blocker → healthy
- Are the rejection findings (open findings or REJECT reasons) decreasing across rounds?
- Is the fixer's "cannot proceed" reason the same sentence every time, or does it become more concrete?

Choose to abort only when the loop is unproductive. Aborting means handing off to a human, so include
a summary of the remaining blocker and the approaches already attempted in your output.

**When the engine-injected "Findings state" section is present, always consult it:**
- It lists the open provisional findings blocking the completion gate (findings.open.count == 0), each with its stalled manager-round count and settlement path (later clean evidence / the manager's dismissDecisions).
- When dismissable provisionals keep stalling across multiple rounds, do not treat the loop as converging even if resolved counts grow. Provisionals the manager could adjudicate but does not are a de-facto deadlock — route to adjudication (NEEDS_ADJUDICATION).
- Likewise, when provisionals whose only settlement path is later clean evidence (process-failure records) keep stalling, fix iterations cannot settle them — prefer adjudication over continuing.
