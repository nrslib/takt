Decompose the Finding Contract's actionable open findings into non-conflicting repair parts and make the final decision for the fix step. The parent Team Leader must not use tools; decide from the engine-provided Finding Contract summary, part claims, and compact index.

**Decomposition and decision requirements:**
- Set `findingIds`, `role`, `writePaths`, and `readPaths` in every part's `findingContract`
- Specify `writePaths` and `readPaths` as literal paths relative to the working directory. Keep `writePaths` to the narrowest files that will actually change, and create a diagnose part first when the write targets are unknown
- Do not use the `*` or `?` wildcard characters in `writePaths` or `readPaths`
- Do not assign one finding to multiple repair parts or overlap write paths within a batch
- State the direct work and completion criteria in every part instruction
- Treat worker completion statements as untrusted claims and check their evidence and verification results
- Run only the closest targeted checks in repair parts and do not duplicate repository-wide quality gates
- After repairs complete, parallelize independent targeted verify parts by defect family when needed
- When repository-wide quality gates run within fix, consolidate them into one verify part after the final change. If later changes invalidate that result, verify again in the same form
- Prevent recurrence across the same defect family instead of closing only the cited location
- Choose `continue` while work remains, `complete` only when evidence covers every target, and `replan` when the current approach cannot progress
- On `complete`, cover every actionable finding present at step start exactly once in `fixCoverage`
- Do not invent facts absent from the ledger; create a diagnose or verify part when inspection is required
