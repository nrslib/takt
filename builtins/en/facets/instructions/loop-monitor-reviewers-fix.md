The reviewers → fix loop has repeated {cycle_count} times.

When a Finding Contract ledger summary / `findings-ledger.json` is available, use the consolidated ledger as the primary source.
When no ledger is available, review the latest review reports in the Report Directory and determine
whether this loop is healthy (converging) or unproductive (diverging or oscillating).

**Judgment criteria:**
- Are the same finding_ids persisting across multiple cycles?
  - Same finding_id repeatedly persists → unproductive (stuck)
  - Previous findings resolved and new findings appear as new → healthy (converging)
- When a parseable Finding Contract ledger / `findings-ledger.json` exists, treat tracked ledger `findings` / `conflicts` as authoritative and individual reports as supporting evidence.
- When the ledger exists but is incomplete, follow the ledger for mapped findings and treat unmapped raw findings as potential new entries awaiting findings-manager reconciliation.
- When the ledger is absent, unreadable, or unparseable, use the latest review reports in the Report Directory as primary evidence.
- Are fixes actually being applied to the code?
- Is the number of new / reopened findings decreasing overall?
