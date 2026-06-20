Verify existing evidence for tests, builds, and functional checks, then perform final approval.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff, execution evidence, and reports

## Step-Specific Additional Procedure

1. Extract each requirement from the task spec one by one
   - If a single sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
     - Example: treat `global/project` as separate requirements
     - Example: treat `JSON override / leaf override` as separate requirements
     - Example: split parallel expressions such as `A and B`, `A/B`, `allow/deny`, or `read/write`
2. For each requirement, identify the implementing code (file:line)
3. Verify the code actually fulfills the requirement (read the file, check existing test/build evidence)
   - Do not mark a composite requirement as ✅ based on only one side of the cases
   - Do not reinterpret required task items as optional, out of scope, or different requirements without explicit evidence
   - For requirements involving IDs, names, metadata, config, environment variables, or output contracts, verify entry points, execution modes, and missing-value behavior separately
   - Do not rely on the plan report or pure-review judgment; independently verify mergeability
   - For requirements involving side effects or state changes, separate verification of happy paths, failure paths, and cleanup
   - If any requirement is unfulfilled, REJECT
4. Re-evaluate prior review findings
   - If a finding does not hold in code, classify it as `false_positive`
   - If a finding holds technically but pushes work beyond the task objective or justified scope, classify it as `overreach`
   - Judge `resolved` against the original finding's expected result, acceptance criteria, and task requirement, not merely against the patch
   - Do not leave `false_positive` / `overreach` reasoning implicit
5. If the diff adds or changes a shared helper, normalizer, builder, or adapter, reconcile its contract against existing branches with the same responsibility
   - Even when absent from the requirements table, contract inconsistencies introduced by the diff must be treated as unverified scope or a REJECT reason

## Report Priority (supervise-specific)

- Do not treat summary reports as primary evidence. Use execution-result reports, reviewer reports with concrete verification details, and actual code in that order
- You may treat `Build Results` / `Test Results` sections in execution-result reports as primary evidence
- For `architecture-review`, `qa-review`, `testing-review`, `security-review`, and `pure-review`, prioritize each report's `Verification Evidence` section
- Treat each `Verification Evidence` item as supporting evidence only when it states the verified target, what was checked, and observed result. If any part is missing, mark that item as `unverified`
- Evidence based on mocks, static inspection, or limited unit tests must not be treated as verification beyond that scope
- If items of evidence conflict, prioritize them in this order: `execution-result report > reviewer report with concrete verification details > summary report`

## Output

- Follow the `supervisor-validation` output contract to record requirements fulfillment, prior finding re-evaluation, verification evidence, and unverified scope
- Only when APPROVE, follow the `summary` output contract to produce the completion summary
