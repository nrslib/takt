**Contract family role: `fix-retry`**

{{include:instructions/contract-family-core}}

Reconstruct the complete graph of every accepted family that the verifier classified as `incomplete`. Invalidate the previous search and proof method, reopen every `participates` path closed by the same assumption, and rescan and repair aliases, obsolete paths, unmigrated consumers, and one-sided updates.

If the plan omits the family, owner, required path, or acceptance condition, do not invent it through editing; report the plan defect.
