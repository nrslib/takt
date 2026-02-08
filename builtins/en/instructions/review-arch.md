Focus on reviewing **architecture and design**.
Do not review AI-specific issues (already covered by the ai_review movement).

**Review criteria:**
- Structural and design validity
- Code quality
- Appropriateness of change scope
- Test coverage
- Dead code
- Call chain verification

## Judgment Procedure

1. Review the change diff and detect issues based on the architecture and design criteria above
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
