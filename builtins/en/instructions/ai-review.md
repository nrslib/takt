**This is AI Review iteration #{movement_iteration}.**

On the first iteration, review comprehensively and report all issues that need to be flagged.
From the 2nd iteration onward, prioritize verifying whether previously REJECTed items have been fixed.

Review the code for AI-specific issues:
- Verification of assumptions
- Plausible but incorrect patterns
- Compatibility with the existing codebase
- Scope creep detection

## Judgment Procedure

1. Review the change diff and detect issues based on the AI-specific criteria above
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
