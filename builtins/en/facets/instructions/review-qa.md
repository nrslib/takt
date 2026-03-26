Review the changes from a quality assurance perspective.

**Review criteria:**
- Test coverage and quality
- Test strategy (unit/integration/E2E)
- Error handling
- Logging and monitoring
- Maintainability


**Design decisions reference:**
Review {report:coder-decisions.md} to understand the recorded design decisions.
- Do not flag intentionally documented decisions as FP
- However, also evaluate whether the design decisions themselves are sound, and flag any problems

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved`
- If status is `persists`, provide concrete unresolved evidence (file/line)

## Judgment Procedure

1. First, extract previous open findings and preliminarily classify as `new / persists / resolved`
2. Review the change diff and detect issues based on the quality assurance criteria above
   - Cross-check changes against REJECT criteria tables defined in knowledge
   - Even if tests pass, verify whether any additional change outside the task or plan is justified
   - If review-driven follow-up changes expand the design, evaluate whether that extra change is actually necessary
3. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
4. If there is even one blocking issue (`new` or `persists`), judge as REJECT
