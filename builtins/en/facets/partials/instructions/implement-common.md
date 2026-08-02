{{include:instructions/change-contract-traceability}}

**Important:**
- Build verification is mandatory. After implementation, run the build or type check and verify that it succeeds
- Test execution is mandatory. After the build succeeds, run the relevant tests and verify the results
- Define newly introduced contract strings such as file names and config keys as constants in one place
- The plan and existing tests are minimum obligations, not proof that the implementation is complete. Map every contract ID to implementation locations and direct verification evidence
- For contracts with impact paths, re-scan equivalent branches, auxiliary entry points, and consumers from the current code, then verify migrated paths, preserved paths, and removed obsolete paths
- Only when continuous execution, re-entry, parallel interleaving, or failure terminals exist in a contract's impact path, verify the relevant scenarios from an entry point that can observe the contract
- Do not use a broad suite pass, a test file name, or static inspection alone as evidence that an individual contract is verified
- For items that cannot be demonstrated because of the environment, separate deterministic alternative verification from the remaining unverified scope. Do not treat an environment-only evidence gap as an implementation defect when repeating work in the same environment cannot add evidence

**Pre-completion self-check (required):**
Before build and tests, audit the implementation against Policy.
1. Open the Policy Source path and read the full content
2. List every `##` section without cherry-picking
3. Match the REJECT criteria in every section against the implementation
4. Exercise each contract ID's counterexample against the current implementation and observe the expected behavior from an entry point that directly exposes the contract
5. Do not select implementation complete when a high-risk contract lacks evidence that can still be obtained within the current scope
