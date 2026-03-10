The ai_review ↔ ai_fix loop has repeated {cycle_count} times.

Review the reports from each cycle and determine whether this loop
is healthy (making progress) or unproductive (repeating the same issues).

**Reports to reference:**
- AI Review results: {report:ai-review.md}

**Judgment criteria:**
- Are the same finding_ids persisting across multiple cycles?
  - Same finding_id repeatedly persists → unproductive (stuck)
  - Previous findings resolved and new findings appear as new → healthy (progressing)
- Are fixes actually being applied to the code?
