**Contract family role: `fix-verifier`**

{{include:instructions/contract-family-core}}

Independently of the fix report, reconstruct the owner and complete graph of every accepted family. Falsify every `participates` path, unmigrated consumer, obsolete path, alias, one-sided update, and `preserved` contract.

Return `incomplete` when the plan contains the obligation but implementation or evidence is missing. Return `plan_invalid` when the plan omits a required family, owner, path, or acceptance condition that another fix cannot close. Do not return `verified` from a test pass alone.
