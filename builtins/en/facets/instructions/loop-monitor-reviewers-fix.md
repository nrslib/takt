The reviewers → fix loop has repeated {cycle_count} times.

Review the latest review reports in the Report Directory and determine
whether this loop is healthy (converging) or unproductive (diverging or oscillating).

**Judgment criteria:**
- Are the same finding_ids persisting across multiple cycles?
  - Same finding_id repeatedly persists → unproductive (stuck)
  - Previous findings resolved and new findings appear as new → healthy (converging)
- Are fixes actually being applied to the code?
- Is the number of new / reopened findings decreasing overall?
