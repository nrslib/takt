The ai_review (reviewer) and ai_fix (coder) disagree.

- ai_review flagged issues and issued a REJECT
- ai_fix reviewed and determined "no fix needed"

Review both outputs and arbitrate which judgment is valid.

**Reports to reference:**
- AI review results: {report:ai-review.md}

**Judgment criteria:**
- Whether ai_review's findings are specific and point to real issues in the code
- Whether ai_fix's rebuttal has evidence (file verification results, test results)
- Whether the findings are non-blocking (record only) level or actually require fixes
