Review the changes from a quality assurance perspective.

**Review criteria:**
- Test coverage and quality
- Test strategy (unit/integration/E2E)
- Error handling
- Logging and monitoring
- Maintainability

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved`
- If status is `persists`, provide concrete unresolved evidence (file/line)

## Judgment Procedure

1. First, extract previous open findings and preliminarily classify as `new / persists / resolved`
2. Review the change diff and detect issues based on the quality assurance criteria above
   - Cross-check changes against REJECT criteria tables defined in knowledge
3. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
4. If there is even one blocking issue (`new` or `persists`), judge as REJECT
