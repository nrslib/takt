{{include:instructions/implementation-path-check}}
{{include:instructions/change-contract-traceability}}

**Implementation and verification:**
- Implement the smallest change required by the request and change contracts. Smallest means a direct change that satisfies requirements and real safety conditions, not the fewest lines.
- When the task supplies judgment criteria or reference material, use only what applies to the changed contract, boundary, and real impact paths. Complete the procedure from the request, current code, and observable contracts even when none is supplied.
- Explore implementations with the same meaning, contract, and reason to change, and responsibility boundaries that exist now. Confirm candidate owners and evidence; decide consolidation or abstraction from the current architecture and any provided applicable criteria.
- Resolve unused code, one-sided updates, and directly affected inconsistencies created by the change. Do not edit unrelated pre-existing issues.
- Verify observable contracts in tests. When the task supplies test-related judgment criteria, follow them as well.
- After implementation, run the build or type check and relevant tests, mapping direct evidence to each changed contract. Record environment-limited verification separately instead of guessing that it is an implementation defect.

{{include:instructions/post-edit-self-scan}}
