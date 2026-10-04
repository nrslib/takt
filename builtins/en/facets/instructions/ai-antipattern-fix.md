Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Required actions:**
1. Open all flagged files with the Read tool
2. Search for the problem areas with grep to confirm they exist
3. Fix the confirmed issues with the Edit tool
4. Run tests to verify
5. Report specifically "what you checked and what you fixed"

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/repair-path-check}}

{{include:instructions/post-edit-self-scan}}

Do not conclude that no change is needed without showing the verification result for each target file. For generated output or specification synchronization, verify the source or specification before reaching a conclusion; otherwise state what could not be verified and why.

Record the inspected files, searches, changes, tests, and other verification in the requested format.
