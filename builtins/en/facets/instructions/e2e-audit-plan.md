Audit the target for E2E coverage before making changes.

**What to do:**
1. Enumerate all user entry points, major routes, task flows, and failure paths from the codebase
2. Read the existing E2E tests and map which flows and scenarios are already covered
3. Build a complete list of auditable user flows and scenario variants
4. Identify missing E2E scenarios and prioritize them by user impact and regression risk
5. Prepare an implementation order that covers the highest-risk missing scenarios first

**Important:**
- Start from complete route and flow enumeration, not from a few obvious pages
- Include unhappy paths, permission differences, and recovery paths when relevant
- If a flow cannot be audited from local code and tests alone, state the missing evidence explicitly
