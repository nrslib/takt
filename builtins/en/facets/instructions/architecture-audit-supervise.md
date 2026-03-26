Verify the completeness and quality of the architecture audit itself.

**Important:** Refer to these reports:
- Plan report: {report:01-architecture-audit-plan.md}
- Audit report: {report:02-architecture-audit.md}

**Verification procedure:**
1. Cross-check the module inventory from the plan against the audited modules in the audit report
2. Reject if important modules or boundaries remain unaudited
3. Reject if key dependency directions, wiring paths, ownership boundaries, or call chains from the plan are missing from the audit result without an explicit reason
4. Verify the audit report includes concrete structural evidence, not just design opinions
5. Verify the report includes the enumeration commands used and that they are sufficient to support the claimed scope
6. Sample-read a few high-risk modules yourself to confirm the structural claims are credible
7. Require re-audit if findings or suggested issue titles are too vague to file directly
