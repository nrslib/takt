Review the implementation semantics. Judge whether the meaning of the code is correct, not whether the tests pass.

Steps:
1. If a Knowledge Source Path is provided, open it and check the criteria in its `##` sections
2. Read the diff and surrounding code, scanning for:
   - Dictionary/collection type choices that do not match the meaning of the data (dynamic-key Records, membership checks via `in`)
   - Derivable values maintained in parallel as separate variables
   - Variable/parameter names that do not match the meaning of the values actually stored
   - Contract violations or impossible states silently ignored
   - References to internal state returned raw
3. Include the location, the concrete conditions under which it breaks, and the fix direction in every finding
4. Do not raise unfounded speculation or preference-only rewrites

**This is review iteration {step_iteration}.**
From the second iteration onward, as a separate step from confirming previous findings,
re-scan the entire cumulative diff from the base (task start) against every chapter of the
Policy / Knowledge criteria. Record the chapters checked and the evidence in the report's
Re-scan Evidence section (required even on APPROVE).
