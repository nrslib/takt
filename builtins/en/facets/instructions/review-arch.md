Focus on reviewing **architecture and design**.
Do not review AI-specific issues (already covered by the ai_review movement).

**Review criteria:**
- Structural and design validity
- Code quality
- Appropriateness of change scope
- Test coverage
- Dead code
- Call chain verification
- Scattered hardcoding of contract strings (file names, config key names)

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved`
- If status is `persists`, provide concrete unresolved evidence (file/line)

## Judgment Procedure

1. First, extract previous open findings and preliminarily classify as `new / persists / resolved`
2. Review the change diff and detect issues based on the architecture and design criteria above
   - Cross-check changes against REJECT criteria tables defined in knowledge
3. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
4. If there is even one blocking issue (`new` or `persists`), judge as REJECT
