Audit the project architecture before making changes.

**What to do:**
1. Enumerate the main modules, layers, boundaries, and public entry points using Read, Glob, and Grep
2. Identify the dependency directions, shared abstractions, and major call chains
3. Build an audit scope that covers all modules relevant to structure, ownership, and wiring
4. Highlight modules with higher architectural risk (boundary leaks, giant files, scattered logic, coupling hotspots)
5. Prepare an audit order that reviews the highest-risk modules first

**Important:**
- Start from full module and boundary enumeration, not from a few suspicious files
- Focus on structure and wiring, not style-only comments
- If the architecture cannot be inferred from code alone, state the missing evidence explicitly
