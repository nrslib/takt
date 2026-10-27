Use existing tests to check contracts verifiable before implementation, and write tests for gaps identified from the plan. You do not need to determine every additional test that may become necessary during implementation in this step.
Refer only to reports in the Report Directory shown in Workflow Context. Do not search or reference other report directories. You may inspect repository source, existing tests, and configuration needed to verify the contract.

**Important: Do NOT create or modify production code. Only test files may be created.**

{{include:instructions/test-obligation-mapping}}
{{include:instructions/change-contract-traceability}}
{{include:instructions/test-contract-discrimination}}

**Test boundaries:**
- Decide whether to create, update, or delete tests from observable contracts, and follow test-related judgment criteria supplied by the task
- Failures caused by not-yet-implemented production code are expected at this stage; fix test defects that would remain afterward
- Do not skip tests solely because production code is not implemented. If implementation must come first to make creating the necessary tests possible, record the concrete reason and the tests to create and run afterward

**Post-edit checks:**
- Check arguments, variables, functions, exports, imports, and types made unused by the test changes, and the dependency direction of added or changed imports. Check that added or changed mocks and test doubles match their real contracts
- Run created or changed tests through the project's test entrypoint and fix defects in the tests themselves. If changed integration tests require classification or wiring checks, run those too
- There is no need to inspect or run every existing mock and test double. Carry any unresolved matters forward to post-implementation verification
