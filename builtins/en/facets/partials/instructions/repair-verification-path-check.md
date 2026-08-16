{{include:instructions/contract-path-analysis}}

Independently reconstruct the invariant, responsible source, and complete affected path graph for every planned problem. Do not use physical code location or file path as identity. Falsify only paths in the bounded graph recorded in the plan. Include an unvisited consumer only when it is governed by the same invariant and is required by the acceptance criteria; do not add an adjacent contract.

Update recurrence records and carry-forward artifacts to stay consistent with the plan and output contract. Reconstruct missing carry-forward artifacts from the plan and record the reason. Do not treat that deficiency alone as grounds for a plan change. Distinguish missing implementation or evidence for a planned obligation from a plan whose assumptions, boundary, method, or evidentiary power must change. Do not declare completion from a test pass alone.
