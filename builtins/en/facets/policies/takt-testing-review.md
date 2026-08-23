# TAKT Test Review Criteria

Inspect TAKT tests, runners, scripts, and CI wiring from their actual dependency boundaries and observable contracts.

## Decision Criteria

| Situation | Decision |
|-----------|----------|
| Isolated logic whose direct dependencies are replaced with test doubles | Unit |
| Real filesystem, bounded storage, or multiple integrated components | Light integration |
| Real child process, Git, complete workflow engine, or measured resource-heavy execution | Heavy integration |
| Runs through a public user entry point and observes user-visible results | E2E |
| Uses a real process but invokes a fake CLI through an internal client | Heavy integration, not E2E |
| Chooses a test layer only from speed or file name | REJECT |
| Removes a heavy integration test from the unit gate without routing it elsewhere | REJECT |
| Runs heavy integration tests in multiple workers within one runner | REJECT |
| Splits heavy integration tests across isolated runners in pull-request CI | OK |
| A recorded result for a changed heavy integration test is supplied | Treat it as evidence only to the extent that the target command, completion state, and result match |
| No recorded result for a test or gate is supplied | Unverified; absence alone is not a finding |

## Inspection Scope

- Read the actual call chain, side effects, runner, script, and CI wiring traversed by each changed test
- For added or changed integration tests, confirm that the classification contract test and target test reach the applicable runner
- For changes to process lifetime, confirm that test code observes the contract-relevant paths among normal completion, startup failure, post-start failure, wait limit, and applicable interruption, cancellation, or forced termination
- Do not infer execution success from the presence of test code; treat only what supplied reports, logs, and recorded results state as execution evidence
