{{include:instructions/test-obligation-mapping}}

Implement missing E2E tests based on the test case list.

**Important:** Refer to the test plan report: {report:01-e2e-coverage-plan.md}

**Note:** If Previous Response exists, this is a resubmission.
Check which test cases were flagged as unimplemented and implement them.

**What to do:**
1. Review the numbered test case list from the test plan
2. Implement tests following existing E2E test patterns (file structure, helpers, fixtures, mock strategy)
3. Implement ALL cases in the test case list (do not stop after implementing just a few)
4. Run E2E tests and confirm all tests pass
5. Confirm existing E2E tests are not broken

**Implementation constraints:**
- Do not modify the existing E2E test framework
- Write one scenario per concern with clear expected results
- Follow existing fixture/helper/mock patterns for cases with external dependencies

{{include:instructions/post-edit-self-scan}}

**Required output (include headings)**
## Implemented Test Cases
- {Test case list number and corresponding test file/test name}
## Unimplemented Test Cases (if any)
- {Number and reason for not implementing}
## Test Results
- {Execution command and results}
