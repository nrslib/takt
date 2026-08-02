# Fix Plan

## Result: finalized

## Root Cause
Two stateful boundaries implement only representative examples of their contracts. Report production can infer attribution from mutable ambient state, while attempt completion and checkpoint resume apply outcome-specific state changes without enforcing the contract's related fields as one invariant.

## Fix Units
| Fix Unit | Findings | Source of Truth | Participating Paths | Complete Invariants | Verification | Completion Condition |
|----------|----------|-----------------|---------------------|---------------------|--------------|----------------------|
| FP-01 | ATTR-001 | `reportAttributionContract` in `src/remediation-contract.js` and the public producer exports | Discover all producers named by the contract and their emitter boundary | Attribution comes from the producing operation, absence follows the declared failure behavior, and existing public producer signatures remain valid | Derive falsifying examples from the contract and add durable behavior-level regression evidence; incidental error wording and implementation identity are not contracts | Every producer and boundary behavior declared by the source of truth is implemented and independently falsifiable without changing the contract |
| FP-02 | STATE-001 | `attemptLifecycleContract` in `src/remediation-contract.js` and the attempt/checkpoint public functions | Derive completion, validation, and resume paths from the contract rather than from the latest verifier examples | Every declared outcome, correlation, resume field, and preservation rule holds together | Derive a behavior matrix from the contract, including preservation obligations and invalid correlations; accept equivalent immutable values | The complete contract is implemented without input mutation and durable evidence fails when any one declared obligation is violated |

## Dependency Order
1. Read each source-of-truth contract and enumerate its correction and preservation obligations before editing.
2. Implement FP-01 across the emitter boundary and every producer declared by the contract while preserving public signatures.
3. Implement FP-02 across completion, validation, and resume as one lifecycle contract.
4. Add behavior-level regression evidence that independently falsifies every derived obligation, then run the project quality gates.
