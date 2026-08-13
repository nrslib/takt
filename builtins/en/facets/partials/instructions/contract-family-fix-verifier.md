**Contract family role: `fix-verifier`**

{{include:instructions/contract-family-core}}

Independently of the fix report, reconstruct the owner and complete graph of every accepted family. Falsify every `participates` path, unmigrated consumer, obsolete path, alias, one-sided update, and `preserved` contract.

Own recurrence updates for every planned invariant under the shared definition. Advance state only for an invariant that is `incomplete` in the current sweep; preserve every other row. When a trigger is true, name an enforcement-point candidate and direct the next fix there rather than to the reported path.

Reconstruct artifact-deficient carry-forward from the plan and record the deficiency without returning `plan_invalid` for that reason. Return `incomplete` when the plan records the invariant, owner, and applicable enforcement obligation but implementation or evidence is missing. Return `plan_invalid` only when the plan omits or inconsistently records a required family, invariant, owner, path, acceptance condition, applicable enforcement boundary, or conditionally required enforcement point. Do not return `verified` from a test pass alone.
