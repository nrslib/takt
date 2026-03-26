Verify the completeness and quality of the unit test audit itself.

**Important:** Refer to the audit plan report: {report:01-unit-audit-plan.md}

**Verification procedure:**
1. Cross-check the full target inventory in the plan against the audited files and behaviors in the audit report
2. Reject if any production file, exported API, branch, error path, boundary check, or state transition from the plan is missing from the audit result without an explicit reason
3. Verify the audit report includes concrete evidence for both covered and missing behaviors, not just conclusions
4. Verify the report includes the enumeration commands used and that they are sufficient to support the claimed scope
5. Sample-read a few target production files and corresponding tests yourself to confirm the coverage claims are credible
6. Require re-audit if issue titles, priorities, or recommended actions are too vague to be filed directly
