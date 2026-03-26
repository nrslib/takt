Decompose the E2E audit, assign flows to each part, and execute in parallel.

**Important:** Refer to the plan report: {report:01-e2e-audit-plan.md}

**What to do:**
1. Review the user flow list, existing scenarios, and risk areas from the plan report
2. Split the audit into 3 groups by feature area or route cluster
3. Assign exclusive ownership so every audited flow is reviewed once

**Each part's instruction MUST include:**
- Assigned routes, entry points, and corresponding E2E files
- The happy paths, failure paths, and permission variants to verify
- Required audit procedure:
  1. Read the relevant code for the assigned flows
  2. Read the corresponding E2E tests in full
  3. Record covered and missing scenarios with concrete evidence
- Completion criteria: every assigned flow has been audited and findings are reported in issue-ready form

**Constraints:**
- Each part is read-only
- Do not modify E2E tests or production code
- Do not audit routes outside the assignment
