# TAKT Test Execution Policy

Classify TAKT tests by real boundaries while preserving both development speed and completion evidence.

The term light IT refers to tests run by `npm run test:it`, and heavy IT refers to tests run by `npm run test:it:heavy`.

## Principles

| Principle | Criteria |
|-----------|----------|
| Classify by real boundary | Choose the layer from dependencies actually crossed, not filename or duration |
| Keep unit in the development loop | Use the fast unit gate for repeated implementation feedback |
| Confirm completion with light IT | Run the light IT gate when implementation is complete |
| Self-verify changed heavy IT | The owner runs every added or changed heavy IT test as a target with `npm test -- <test-file>` |
| Do not run unrelated heavy IT | Do not run heavy IT other than tests added or changed, or tests that directly verify the current change. Run permitted tests as targets with `npm test -- <test-file>` |
| Verify the classification contract directly | Run the classification contract test by itself after adding or changing an integration test |
| Keep full heavy IT in PR / release gates | PR CI and release verification run the complete heavy IT suite, including unchanged coverage |
| Do not run the full heavy IT suite locally | Local execution of the full heavy IT suite (`npm run test:it:heavy`) is REJECT. Run it only when explicitly instructed by the user |
| Do not delegate first execution to PR | The PR gate does not replace targeted execution of a changed heavy IT test |
| Report completed evidence | Report completion and exit status, not merely that a command started |

## Layer Classification

Use the unit, light IT, heavy IT, and E2E boundary definitions in TAKT knowledge as the source of truth. When classification is unclear, inspect the actual call chain and side effects.

| Criteria | Judgment |
|----------|----------|
| Individual logic with direct dependencies replaced by test doubles | Unit |
| Real filesystem, bounded storage, or multi-component composition | light IT |
| Real child process, Git, complete workflow engine, or measured resource-heavy execution | heavy IT |
| Full execution from a user-facing entry point with user-visible observations | E2E |
| Real process used by an internal client to call a fake CLI | heavy IT, not E2E |
| Layer changed only because a test is slow | REJECT |

## Development Verification

Repeat the unit gate during implementation and run the light IT gate once the implementation is coherent. Do not run the full heavy IT suite (`npm run test:it:heavy`) locally unless explicitly instructed by the user.

| State | Required Verification |
|-------|-----------------------|
| Production code only changed | Targeted unit coverage and light IT at completion |
| Unit test added or changed | Targeted unit test and unit gate |
| light IT test added or changed | Targeted test and light IT gate |
| heavy IT test added or changed | Standalone classification contract test and targeted execution of the changed heavy IT test |
| Classification or runner changed | Unit, light IT, and heavy IT exclusivity and routing contracts |

After adding or changing an integration test, run the classification contract test by itself without waiting for a full gate.

```bash
npm test -- src/__tests__/releaseVerificationWiring.test.ts
```

## Heavy IT Handling

PR CI and release verification run the full heavy IT suite, but work must not be handed off before every changed heavy IT test has succeeded at least once. Locally, run only heavy IT added or changed, or heavy IT that directly verifies the current change, as targets with `npm test -- <test-file>`.

| Criteria | Judgment |
|----------|----------|
| Added or changed heavy IT runs to completion as a target with `npm test -- <test-file>` | OK |
| Existing heavy IT that directly verifies the current change runs as a target with `npm test -- <test-file>` | OK |
| Heavy IT other than tests added or changed, or tests that directly verify the current change, runs | REJECT. Do not run it |
| The full heavy IT suite (`npm run test:it:heavy`) runs locally | REJECT. Run it only when explicitly instructed by the user |
| PR-wide execution is the first run of a changed heavy IT test | REJECT |
| Timeout increase alone is treated as resolving a hang, contention, or infinite loop | REJECT |
| A heavy IT test is removed from unit without being connected to another gate | REJECT |

Pull-request CI keeps heavy IT at one worker per runner, splits heavy parallel across six isolated shard runners, and uses a separate runner for each serial group.

Tests in heavy parallel must use `mkdtemp` to isolate resources so they do not contend on shared paths such as repository files, fixed `/tmp` paths, or directory listings directly under `tmpdir()`. Put tests whose contention cannot be avoided in a serial group.

| Execution Mode | Judgment |
|----------------|----------|
| Pull-request CI shards across isolated runners | OK |
| Tests in heavy parallel contend on shared paths | REJECT |

## Process and Asynchronous Verification

When child-process launch or completion, or a lifetime independent of the parent process, changes, do not treat mocked launch confirmation as completion. Verify the lifetime and observable result on which the user depends with a real process. Do not require a real process for every wait that has no process-lifetime contract.

| Change | Required Verification |
|--------|-----------------------|
| Worker target or launch method | The target module loads from every supported execution mode, including source/development execution when it is supported |
| Work independent of the parent CLI | An artifact or persisted failure remains observable when the parent exits before the worker |
| Polling or marker wait | Success, transient read contention during publication, and the wait bound all finish in finite time |
| Child-process failure | Distinguish launch failure from nonzero exit or module-load failure after launch |
| Terminal paths involving the changed process or resource lifetime | Distinguish real failure, interruption, cancellation, and forced-termination paths; verify the required terminal result, child and descendant termination, and temporary-resource cleanup. Record applicable unexecuted paths and paths where cleanup cannot run |

Classify verification that crosses a real child-process boundary as heavy IT. Avoid a Cartesian product: select the smallest cases among execution modes directly affected by the changed responsibility that distinguish normal completion, wait-bound completion, post-launch failure, and applicable interruption, cancellation, or forced-termination behavior. Do not require terminal cases for lifetimes or resources that the change does not directly affect. Record applicable paths that cannot run locally.

## Completion Evidence

Reports distinguish the gates or target tests executed, their completion results, and full heavy IT execution deferred to the pull-request gate.

| Evidence | Judgment |
|----------|----------|
| Successful unit and light IT results | Normal implementation completion evidence |
| Successful targeted result for every added or changed heavy IT test | Required evidence for heavy IT changes |
| Fact that a command started | Insufficient |
| Statement that PR will run it | Insufficient evidence for a changed heavy IT test |
| Failure labeled a flake by inference alone | Insufficient; investigate reproduction conditions and direct cause |

## Prohibitions

- **Duration-only classification** - Confuses slow unit tests with tests that cross integration boundaries
- **Unrouted exclusion** - Creates a test that no gate executes
- **Unexecuted changed test** - Delegates first execution of an added or changed heavy IT test to PR
- **Unverified classification contract** - Omits the standalone classification contract test after adding or changing an integration test
- **Shared-path contention in heavy parallel** - Leaves tests without isolation so they contend on repository files or temporary paths
- **Premature success report** - Treats running commands, timeouts, or worker communication errors as success
- **Classification-documentation drift** - Lets runners, development guidance, and TAKT knowledge describe different execution orders
