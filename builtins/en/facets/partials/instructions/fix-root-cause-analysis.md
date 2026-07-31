**Root-cause and responsibility analysis (required):**
1. Treat the reported location as the starting point, then verify the problem, direct cause, and root cause in the current code.
2. Classify it as an independent local issue or a structural issue involving responsibility, source of truth, or contract.
3. For a structural issue, identify the authoritative requirement, specification, schema, or public contract; do not treat the counterexamples named in a finding as the upper bound of completion scope.
4. Derive its valid conditions, forbidden conditions, and boundary values, then map each one to participating entries, types and schemas, validation boundaries, consumers, state, side effects, and failure paths.
5. Treat open findings and unmigrated contract paths with the same cause as one fix unit.
6. Check evidence that could disprove the assumed cause, and revise the analysis before editing when it does.
