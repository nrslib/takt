Verify the completeness and quality of the E2E audit itself.

**Important:** Refer to the audit plan report: {report:01-e2e-audit-plan.md}

**Verification procedure:**
1. Cross-check the full route and flow inventory in the plan against the audited scenarios in the audit report
2. Reject if any important entry point, user flow, unhappy path, permission variant, or recovery path from the plan is missing from the audit result without an explicit reason
3. Verify the audit report includes concrete evidence for covered and missing scenarios, not just high-level claims
4. Verify the report includes the enumeration commands used and that they are sufficient to support the claimed scope
5. Sample-read a few high-risk routes and corresponding tests yourself to validate the coverage claims
6. Require re-audit if issue titles, priorities, or recommended actions are too vague to be filed directly
