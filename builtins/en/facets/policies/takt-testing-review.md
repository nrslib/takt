# TAKT Test Review Criteria

Inspect TAKT tests, runners, scripts, and CI wiring from their actual dependency boundaries and observable contracts.

The term light IT refers to tests run by `npm run test:it`, and heavy IT refers to tests run by `npm run test:it:heavy`.

## Decision Criteria

| Situation | Decision |
|-----------|----------|
| Isolated logic whose direct dependencies are replaced with test doubles | Unit |
| Real filesystem, bounded storage, or multiple integrated components | light IT |
| Real child process, Git, complete workflow engine, or measured resource-heavy execution | heavy IT |
| Runs through a public user entry point and observes user-visible results | E2E |
| Uses a real process but invokes a fake CLI through an internal client | heavy IT, not E2E |
| Chooses a test layer only from speed or file name | REJECT |
| Removes a heavy IT test from the unit gate without routing it elsewhere | REJECT |
| Tests in heavy parallel contend on shared paths | REJECT |
| Keeps heavy IT at one worker per runner in pull-request CI, with six isolated shard runners for heavy parallel and a separate runner for each serial group | OK |
| Runs the full heavy IT suite (`npm run test:it:heavy`) locally | REJECT. Run it only when explicitly instructed by the user |
| Runs heavy IT other than tests added or changed, or tests that directly verify the current change | REJECT. Do not run it |
| Runs heavy IT added or changed, or heavy IT that directly verifies the current change, as targets with `npm test -- <test-file>` | OK |
| A recorded result for a changed heavy IT test is supplied | Treat it as evidence only to the extent that the target command, completion state, and result match |
| No recorded result for a test or gate is supplied | Unverified; absence alone is not a finding |

## Inspection Scope

- Read the actual call chain, side effects, runner, script, and CI wiring traversed by each changed test
- For added or changed integration tests, confirm that the classification contract test and target test reach the applicable runner
- For changes to process lifetime, confirm that test code observes the contract-relevant paths among normal completion, startup failure, post-start failure, wait limit, and applicable interruption, cancellation, or forced termination
- Do not infer execution success from the presence of test code; treat only what supplied reports, logs, and recorded results state as execution evidence
