# TAKT Test Execution Policy

Classify TAKT tests by real boundaries while preserving both development speed and completion evidence.

## Principles

| Principle | Criteria |
|-----------|----------|
| Classify by real boundary | Choose the layer from dependencies actually crossed, not filename or duration |
| Keep unit in the development loop | Use the fast unit gate for repeated implementation feedback |
| Confirm completion with light integration | Run the light integration gate when implementation is complete |
| Self-verify changed heavy integration | The owner runs every added or changed heavy integration test as a target |
| Verify the classification contract directly | Run the classification contract test by itself after adding or changing an integration test |
| Keep full heavy integration in PR | Pull requests run the complete heavy integration suite, including unchanged coverage |
| Do not delegate first execution to PR | The PR gate does not replace targeted execution of a changed heavy integration test |
| Report completed evidence | Report completion and exit status, not merely that a command started |

## Layer Classification

Use the unit, light integration, heavy integration, and E2E boundary definitions in TAKT knowledge as the source of truth. When classification is unclear, inspect the actual call chain and side effects.

| Criteria | Judgment |
|----------|----------|
| Individual logic with direct dependencies replaced by test doubles | Unit |
| Real filesystem, bounded storage, or multi-component composition | Light integration |
| Real child process, Git, complete workflow engine, or measured resource-heavy execution | Heavy integration |
| Full execution from a user-facing entry point with user-visible observations | E2E |
| Real process used by an internal client to call a fake CLI | Heavy integration, not E2E |
| Layer changed only because a test is slow | REJECT |

## Development Verification

Repeat the unit gate during implementation and run the light integration gate once the implementation is coherent. Full local heavy integration is not a routine completion requirement.

| State | Required Verification |
|-------|-----------------------|
| Production code only changed | Targeted unit coverage and light integration at completion |
| Unit test added or changed | Targeted unit test and unit gate |
| Light integration test added or changed | Targeted test and light integration gate |
| Heavy integration test added or changed | Standalone classification contract test and targeted execution of the changed heavy integration test |
| Classification or runner changed | Unit, light integration, and heavy integration exclusivity and routing contracts |

After adding or changing an integration test, run the classification contract test by itself without waiting for a full gate.

```bash
npm test -- src/__tests__/releaseVerificationWiring.test.ts
```

## Heavy Integration Handling

The pull request owns full heavy integration execution, but work must not be handed off before every changed heavy integration test has succeeded at least once.

| Criteria | Judgment |
|----------|----------|
| Changed heavy integration test completes successfully as a target | OK |
| Related existing heavy integration tests run as targets according to risk | OK |
| Full heavy integration runs locally on every iteration | Not required unless explicitly requested |
| PR-wide execution is the first run of a changed heavy integration test | REJECT |
| Timeout increase alone is treated as resolving a hang, contention, or infinite loop | REJECT |
| A heavy test is removed from unit without being connected to another gate | REJECT |

Keep heavy integration at one worker per runner. Full local execution is serial; pull-request CI scales out across four isolated shard runners and separate runners for each serial group instead of adding workers within one runner.

| Execution Mode | Judgment |
|----------------|----------|
| Full local execution with one worker | OK |
| Pull-request CI shards across isolated runners | OK |
| More workers within one runner for acceleration | REJECT; reintroduces process, Git, and synchronous I/O contention |

## Completion Evidence

Reports distinguish completed unit and light integration results, targeted changed-heavy results, and full heavy integration deferred to the pull-request gate.

| Evidence | Judgment |
|----------|----------|
| Successful unit and light integration results | Normal implementation completion evidence |
| Successful targeted result for every added or changed heavy integration test | Required evidence for heavy integration changes |
| Fact that a command started | Insufficient |
| Statement that PR will run it | Insufficient evidence for a changed heavy integration test |
| Failure labeled a flake by inference alone | Insufficient; investigate reproduction conditions and direct cause |

## Prohibitions

- **Duration-only classification** - Confuses slow unit tests with tests that cross integration boundaries
- **Unrouted exclusion** - Creates a test that no gate executes
- **Unexecuted changed test** - Delegates first execution of an added or changed heavy integration test to PR
- **Unverified classification contract** - Omits the standalone classification contract test after adding or changing an integration test
- **Heavy integration parallelism within one runner** - Adds workers that contend on processes, Git, and synchronous I/O
- **Premature success report** - Treats running commands, timeouts, or worker communication errors as success
- **Classification-documentation drift** - Lets runners, development guidance, and TAKT knowledge describe different execution orders
