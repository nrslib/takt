{{include:instructions/contract-path-analysis}}

Independently reconstruct the invariant, responsible source, and complete affected path graph for every planned problem. Do not use physical code location or file path as identity. Falsify only paths in the bounded graph recorded in the plan. Include an unvisited consumer only when it is governed by the same invariant and is required by the acceptance criteria; do not add an adjacent contract.

For each problem in the plan, confirm that current code, the repair report, and verification results agree. When a report is incomplete, check the plan and code and record why the information was missing. Do not treat an incomplete report alone as grounds for a plan change. Distinguish missing planned changes or evidence from a plan whose assumptions, boundary, method, or verification method must change. Do not declare completion from a test pass alone.
