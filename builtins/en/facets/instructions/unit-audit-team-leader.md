Decompose the unit audit, assign files to each part, and execute in parallel.

**Important:** Refer to the plan report: {report:01-unit-audit-plan.md}

**What to do:**
1. Review the production file list, existing tests, and audited behavior inventory from the plan report
2. Split the audit into 3 groups by module or test area
3. Assign exclusive ownership so every target file and behavior is audited once

**Each part's instruction MUST include:**
- Assigned production files and corresponding test files
- The behaviors, branches, error paths, and boundary checks to verify
- Required audit procedure:
  1. Read every assigned production file in full
  2. Read the corresponding unit tests in full
  3. Record covered and missing behaviors with concrete file evidence
- Completion criteria: every assigned target has been audited and findings are reported in issue-ready form

**Constraints:**
- Each part is read-only
- Do not modify tests or production code
- Do not audit files outside the assignment
