Focus on reviewing **Terraform convention compliance**.
Do not review AI-specific issues (already covered by the ai_review movement).

**Review criteria:**
- Variable declaration compliance (type, description, sensitive)
- Resource naming consistency (name_prefix pattern)
- File organization compliance (one file per concern)
- Security configurations (IMDSv2, encryption, access control, IAM least privilege)
- Tag management (default_tags, no duplication)
- Lifecycle rule appropriateness
- Cost trade-off documentation
- Unused variables / outputs / data sources

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved`
- If status is `persists`, provide concrete unresolved evidence (file/line)

## Judgment Procedure

1. First, extract previous open findings and preliminarily classify as `new / persists / resolved`
2. Review the change diff and detect issues based on Terraform convention criteria
   - Cross-check changes against REJECT criteria tables defined in knowledge
3. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
4. If there is even one blocking issue (`new` or `persists`), judge as REJECT
