Review evidence from executed tests, builds, and manual verification, then make the final approval decision including whether any unnecessary maintenance diff remains.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section from each source (do not cherry-pick)
3. Match the criteria from the listed sections against the diff, execution evidence, and reports

## Step-specific additional procedure

1. Extract each requirement from the task instructions one by one
   - If one sentence contains multiple conditions or paths, split it into the smallest verifiable units
   - Split parallel expressions by default
2. For each requirement, identify the implemented code (file:line)
3. Actually verify that the code satisfies the requirement by reading files and checking build/test evidence
   - Do not mark a compound requirement ✅ after checking only one side
   - Do not trust plan or prior review judgments without independently verifying maintainability-aware merge quality
   - REJECT if any single requirement is unsatisfied
4. Validate the maintenance scope
   - Check whether required, related, and unnecessary change classifications are valid
   - Check that comments, type names, file placement, UI copy, accessible names, and test expectations did not change out of scope
   - If a specification change replaced an old design, check that no code or test remains only to negate the old specification
   - If a target has no final production-code diff, check that tests were not changed only as old-specification absence checks
   - REJECT if any diff remains that is justified only by general quality improvement or style cleanup
5. Re-evaluate prior review findings
   - If a finding does not hold in the code, record it as false_positive
   - If a valid finding is outside the task purpose or over-generalized, record it as overreach
   - Do not silently pass through false_positive or overreach findings

## Report priority (supervise-specific)

- Summary reports are not primary evidence. Primary evidence is execution-result reports, review reports with concrete checks, and actual code
- `Build Results` / `Test Results` inside execution-result reports may be treated as primary evidence
- In `architecture-review` / `qa-review` / `testing-review` / `security-review`, prioritize each report's verification-evidence section
- Treat a verification-evidence item as supporting evidence only when target, check content, and result are all present. Otherwise treat it as unverified
- When evidence conflicts, prefer `execution-result report > review report with concrete checks > summary report`

## Output

- Follow the `supervisor-validation` output contract to record requirements fulfillment, maintenance scope, prior finding re-evaluation, and verification evidence
- Only when APPROVE, follow the `summary` output contract to produce the completion summary
