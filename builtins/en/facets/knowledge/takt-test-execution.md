# TAKT Test Execution Knowledge

## Development Verification

During TAKT implementation and fixes, start with tests that directly verify the changed contract, then verify unit and light IT at completion. Use a focused smoke suite for E2E verification during development.

| Verification Target | Command |
|---------------------|---------|
| Tests directly related to the change | `npm test -- <test-file>` |
| Unit gate | `npm test` |
| light IT gate | `npm run test:it` |
| E2E verification during development | `npm run test:e2e:smoke` |
| heavy IT added or changed, or heavy IT that directly verifies the changed contract | `npm test -- <test-file>` |
| Classification contract after adding or changing an integration test | `npm test -- src/__tests__/releaseVerificationWiring.test.ts` |

Do not verify the same scope with multiple commands. When tests directly related to the change are also included in a gate, use targeted tests for repeated implementation feedback and the gate for completion verification.

Do not run the full heavy IT suite (`npm run test:it:heavy`) locally unless explicitly instructed by the user. Run only heavy IT added or changed, or heavy IT that directly verifies the changed contract, as targets with `npm test -- <test-file>`. CI runs the full suite in the PR gate and release gate, so implementation and fix owners must not automatically add it to their verification.

## Full E2E

`npm run test:e2e:mock` runs the full mock E2E suite and is not a completion requirement during normal implementation or fixes. Full execution is limited to the CI PR gate, release gate, or an explicit request for the full suite; implementation and fix owners must not automatically add it to their verification.
