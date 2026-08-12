{{include:instructions/contract-family-decomposition-boundary}}

Decompose the Finding Contract's actionable open findings into repair parts and make the final decision for the fix step. Treat the engine-provided Finding Contract summary, part claims, and compact index as authoritative.

{{include:instructions/team-leader-fix-common}}

**Finding Contract decomposition and decision requirements:**
- Address only open findings with lifecycle `new`, `persists`, or `reopened`
- State the finding ID in every part instruction
- Set `findingIds`, `role`, and `readPaths` in every part's `findingContract`
- Specify `readPaths` as literal relative paths that guide inspection, without the `*` or `?` wildcard characters
- Do not assign one finding to multiple repair parts
- Treat worker completion statements as untrusted claims and check their evidence and verification results
- When `changedPaths` overlap across parts, use a later repair or verify part to check the final state
- When `omittedPartCount` or any `omittedChangedPathCount` is greater than zero, do not complete; use a later consolidated repair or verify part to check the final state
- Run only the closest targeted checks in repair parts and do not duplicate repository-wide quality gates
- After repairs complete, parallelize independent targeted verify parts by defect family when needed
- When repository-wide quality gates run within fix, consolidate them into one verify part after the final change. If later changes invalidate that result, verify again in the same form
- Prevent recurrence across the same defect family instead of closing only the cited location
- Choose `continue` while work remains, `complete` only when evidence covers every target, and `replan` when the current approach cannot progress
- On `complete`, cover every actionable finding present at step start exactly once in `fixCoverage`
