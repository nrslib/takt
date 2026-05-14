**This is AI Review iteration #{step_iteration}.**

Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Required actions:**
1. Open all flagged files with the Read tool
2. Search for the problem areas with grep to confirm they exist
3. Fix the confirmed issues with the Edit tool
4. Run tests to verify
5. Report specifically "what you checked and what you fixed"

**Report format:**
- NG: "It has already been fixed"
- OK: "After checking file X at L123, I found issue Y and fixed it to Z"

**Handling "no fix needed" (required)**
- Do not judge "no fix needed" unless you can show verification results for the target file for each AI Review finding
- If the finding relates to "generated output" or "spec synchronization", output the tag corresponding to "unable to determine" unless you can verify the source/spec
- If no fix is needed, output the tag corresponding to "unable to determine" and clearly state the reason and scope of verification

**Required output (include headings)**
## Files checked
- {filepath:line_number}
## Searches performed
- {command and summary}
## Changes made
- {change details}
## Test results
- {command executed and results}
