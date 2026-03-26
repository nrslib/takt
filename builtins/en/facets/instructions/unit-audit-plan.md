Audit the target for unit test coverage before making changes.

**What to do:**
1. Enumerate the target production files, exported APIs, internal branches, error paths, boundary checks, and state transitions using Read, Glob, and Grep
2. Read existing unit tests and map which behaviors are already covered
3. Build a complete inventory of auditable behaviors for each target file
4. Identify missing unit tests and prioritize them by regression risk
5. Prepare an implementation order that covers the highest-risk gaps first

**Important:**
- Start from complete enumeration, not from a few obvious gaps
- Do not stop after identifying a handful of missing tests
- If the scope is unclear, state exactly which files or behaviors need clarification
