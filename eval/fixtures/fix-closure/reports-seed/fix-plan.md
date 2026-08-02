# Fix Plan

## Result: finalized

## Root Cause
Three boundaries implement only representative examples of their contracts. Report production can infer attribution from mutable ambient state, attempt completion and checkpoint resume apply outcome-specific state changes without enforcing the contract's related fields as one invariant, and hierarchical call counting applies its kind filter only to the direct projection instead of every recursive and derived path.

## Fix Units
| Fix Unit | Findings | Source of Truth | Participating Paths | Complete Invariants | Verification | Completion Condition |
|----------|----------|-----------------|---------------------|---------------------|--------------|----------------------|
| FP-01 | ATTR-001 | `reportAttributionContract` in `src/remediation-contract.js` and the public producer exports | Discover all producers named by the contract and their emitter boundary | Attribution comes from the producing operation, absence follows the declared failure behavior, and existing public producer signatures remain valid | Derive falsifying examples from the contract and add durable behavior-level regression evidence; incidental error wording and implementation identity are not contracts | Every producer and boundary behavior declared by the source of truth is implemented and independently falsifiable without changing the contract |
| FP-02 | STATE-001 | `attemptLifecycleContract` in `src/remediation-contract.js` and the attempt/checkpoint public functions | Derive completion, validation, and resume paths from the contract rather than from the latest verifier examples | Every declared outcome, correlation, resume field, and preservation rule holds together | Derive a behavior matrix from the contract, including preservation obligations and invalid correlations; accept equivalent immutable values | The complete contract is implemented without input mutation and durable evidence fails when any one declared obligation is violated |
| FP-03 | DEPTH-001 | `hierarchyCountContract` in `src/remediation-contract.js` and the three public counting projections | Treat direct entries, recursive descendants, and maximum-depth projection as separate paths of the same counting invariant | Only the declared kind contributes to totals and depth; non-counted wrapper nodes do not change either result at any nesting level | Use mixed-kind trees where wrappers appear before, between, and below counted nodes; require regression evidence that independently fails when recursive total or maximum depth counts wrappers | All declared projections preserve the same kind-filtered meaning without changing their public signatures |

## Dependency Order
1. Read each source-of-truth contract and enumerate its correction and preservation obligations before editing.
2. Implement FP-01 across the emitter boundary and every producer declared by the contract while preserving public signatures.
3. Implement FP-02 across completion, validation, and resume as one lifecycle contract.
4. Implement FP-03 across direct, recursive, and maximum-depth projections, including nested mixed-kind paths.
5. Add behavior-level regression evidence that independently falsifies every derived obligation, then run the project quality gates.
