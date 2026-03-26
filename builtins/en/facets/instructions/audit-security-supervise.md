Verify the completeness and quality of the security audit.

**Important:** Refer to the plan report: {report:01-plan.md}

**Verification procedure:**

1. **Completeness verification (most important)**
   - Cross-reference the file list from the plan report with files mentioned in the audit results
   - List any files not mentioned in the audit results as "unaudited files"
   - REJECT if even one unaudited file exists

2. **Methodology verification**
   - Check whether each file's audit result references specific code content
   - If a file only says "no issues" without mentioning specific content checked, it may not have been actually Read → REJECT
   - Check for signs that judgment was based solely on Grep keyword matching

3. **Quality verification**
   - Check whether severity classifications of detected issues are appropriate
   - Read a few high-security-risk files yourself to verify no issues were missed
   - Check whether there are too many false positives
