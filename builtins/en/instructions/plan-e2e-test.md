Analyze the target code and identify missing E2E tests.

**Note:** If a Previous Response exists, this is a replan due to rejection.
Revise the test plan taking that feedback into account.

**Actions:**
1. Read target features, implementation, and existing E2E specs (`e2e/specs/**/*.e2e.ts`) to understand behavior
2. Summarize current E2E coverage (happy path, failure path, regression points)
3. Identify missing E2E scenarios with expected outcomes and observability points
4. Specify execution commands (`npm run test:e2e:mock` and, when needed, `npx vitest run e2e/specs/<target>.e2e.ts`)
5. Provide concrete guidance for failure analysis → fix → rerun workflow
