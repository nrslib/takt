The reviewers → fix loop has repeated {cycle_count} times.

When a Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the primary source.
When no ledger is available, review the latest review reports in the Report Directory and determine
whether this loop is healthy (converging) or unproductive (diverging or oscillating).

**Judgment criteria:**
- Are the same finding_ids persisting across multiple cycles?
  - Same finding_id repeatedly persists → unproductive (stuck)
  - Previous findings resolved and new findings appear as new → healthy (converging) as a rule
    - However, when a new finding is another branch of the same `family_tag` as one resolved in a recent cycle, treat it as partial-fix recurrence and count it as unproductive. When the same `family_tag` keeps recurring branch by branch without moving toward closed, choose a replan that requires fixing all branches at once. Decide ABORT by the closing rule below (only when neither fixing, replanning, nor disputing can break the deadlock)
- When a parseable Finding Contract ledger / `findings-ledger.json` exists, treat tracked ledger `findings` / `conflicts` as authoritative and individual reports as supporting evidence.
- When the ledger exists but is incomplete, follow the ledger for mapped findings and treat unmapped raw findings as potential new entries awaiting findings-manager reconciliation.
- When the ledger is absent, unreadable, or unparseable, use the latest review reports in the Report Directory as primary evidence.
- Are fixes actually being applied to the code?
  - If fixes have landed but the same findings keep coming back (the findings
    no longer match the current code), the deadlock is in the findings, not
    the code. A dispute route remains (dispute → manager adjudication →
    waive), so judge this as breakable by replanning and route back to plan.
- Is the number of new / reopened findings decreasing overall?

Choose ABORT only when neither fixing, replanning, nor disputing can break the deadlock.
