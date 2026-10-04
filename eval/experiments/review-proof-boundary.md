# Review proof boundary experiment

## Latest result summary

The fourteenth candidate passes the target and controls below. All counted
results have zero provider errors and were manually inspected in addition to
automatic grading. Adjudication results are retained from unchanged inputs;
testing-review results were freshly evaluated for the final candidate.

| Case | Baseline | Final candidate |
|---|---|---|
| Adjudication: optional observation | 0/1 | 3/3 (unchanged sixth-candidate inputs) |
| Testing review: optional observation | 0/1 | 3/3 |
| Explicit verification obligation | 1/1 | 1/1 |
| Current implementation defect | 1/1 | 1/1 |
| Missing representative failure tests | 1/1 | 1/1 |
| New behavior without an explicit testing directive | Not measured in initial mode | 1/1 |
| Observable handoff defect with covered behavior alongside it | See trial history | 1/1 |

Latest local checks: build, lint, and eval contracts (38/38) passed. Fast unit
(6081 tests) and light integration (2460 tests) passed at the sixth candidate,
before subsequent policy and instruction refinements; these are not reruns on
the final candidate. No TypeScript runtime implementation changed. These are
isolated role evaluations with seeded reports, not an end-to-end review loop
or a statistical guarantee across projects. Changes are on local branch
`fix/review-evidence-boundary`; no PR was created.

## Problem and scope

A reviewer can acknowledge that the current implementation preserves state,
yet keep an already repaired finding open because an arbitrary mutation of a
separate internal state would survive the tests. Mutation sensitivity alone
does not establish that this additional observation is mandatory for the change.
The complementary risk is dismissing a genuine missing behavioral test merely
because no implementation bug has been demonstrated.

The domain-neutral fixture uses a delivery editor. Its new failure branch has
representative tests for the required visible state and absence of a commit.
The unchanged client preserves its internal route on temporary failures.
Three seeded reviewers demand a second delivery to observe that internal route.
The explicit-test, actual-defect, and missing-failure-test controls distinguish
three independently sufficient grounds for required work.

## Fixed experimental conditions

- Baseline: `219276255c31995ffd3c56bf18ddbdc8c690aa2c` builtins.
- Provider: Codex CLI, `gpt-5.6-luna`, reasoning effort `max`, cache disabled.
- Live `peer-review` Phase 1 composition via `eval/scripts/prepare.mjs`.
- Isolated fixture directory; inherited skills disabled; read-only execution.
- Fixture requirements are authoritative. Expected answers and the independent
  behavior oracle are not copied into the isolated fixture.
- Evaluation checks both `DISPOSITION` and the causal explanation. The original
  adjudication RED used the disposition assertion; its explanation was manually
  inspected before editing policy. Semantic rubrics were added before GREEN.

## Reproduction

From this checkout, with dependencies installed and Codex authentication:

```sh
npm run build
npm run lint
npm run eval:prompts:contracts
npm run eval:prompts -- review-proof-boundary testing-proof-boundary --no-cache --repeat 3 --max-concurrency 3
npm run eval:prompts -- review-proof-required-check review-proof-actual-regression review-proof-missing-failure testing-proof-new-behavior testing-review-observable-evidence --no-cache --repeat 1 --max-concurrency 1
```

To reproduce the original baseline, use the same fixture, task, provider, and
assertions with builtins from `219276255c31995ffd3c56bf18ddbdc8c690aa2c` in a
separate checkout. Do not replace the current checkout's builtins while an
evaluation is preparing its snapshots. The baseline lacks the new procedure;
its composition is intentionally different from the candidate. Repeated
candidate tuning uses the same target cases, so their final pass count is
development-set evidence, not an independent estimate of generalization.

## Baseline observations

An exploratory version explicitly said that retry testing was outside the
requirements. Adjudication and testing review both closed the finding. This is
not a RED and is not evidence of improvement. That answer hint was removed;
the final fixture specifies success continuity without forbidding additional
tests. The final fixture is held fixed for the before/after comparison.

The final adjudication baseline (`eval-8QH-2026-09-10T06:12:07`) returned
`DISPOSITION: repair`, with zero provider errors. It acknowledged that neither
temporary failure calls `disconnect`, but required a retry assertion because a
mutation clearing only the client's route could escape the existing tests.
It retained `TEST-DELIVERY-001` and expanded its acceptance criteria. This is
the reproduced RED, not a runner failure or a fabricated implementation defect.

The final testing-review baseline (`eval-WAO-2026-09-10T06:17:40`) also
returned `DISPOSITION: repair`. Both the disposition and semantic assertions
failed: it retained the same finding and demanded a retry observation based on
the hypothetical internal-state mutation. This independently reproduces the
failure in the reviewer, not only in adjudication.

## Policy change

The shared evidence policy separates the obligation to add a test from mutation
sensitivity. It preserves explicit verification obligations, representative
untested conditions of changed behavior, and regression tests for confirmed
defects. Finding tracking separately requires evidence for an added obligation;
ID continuity or reviewer agreement is insufficient. Japanese and English
partials carry the same rules; no product, error code, or fixture name is used.

## First candidate results and limitations

| Evaluation | Before policy change | First policy candidate |
|---|---|---|
| Adjudication, optional observation | 0/1 (RED) | 0/1 valid; two invalid trials excluded |
| Testing review, optional observation | 0/1 (RED) | 1/3; not GREEN |
| Explicit retry-test obligation | 1/1 | 1/1 (see formatting note) |
| Current route-loss defect | 1/1 | 1/1 |
| Missing tests for the new failure branch | 1/1 | 1/1 |

The first-candidate adjudication run (`eval-NoR-2026-09-10T06:19:40`)
reported 2/3 passes, but both passing responses said their designated policy
snapshot was missing and read the testing-review snapshot instead. Separate
prepare invocations had reset a shared fixture directory between trials. Those
two responses are invalid composition trials and are excluded. The initial
baseline REDs used their own freshly prepared, immediately isolated snapshots;
their substantive failures remain RED.

Testing review now has a separate fixture directory with byte-identical task,
source, test, and report inputs. A preparation regression test verifies that
preparing testing review leaves adjudication snapshots intact. The six active
second-candidate trials were inspected before completion: each role's isolated
policy snapshot matched the intended second-candidate snapshot by SHA-256.
This also validates trials started before the directory split, whose isolated
copies already contained the correct role-specific snapshot.

Changed-policy control IDs are `eval-woh-2026-09-10T06:25:01`,
`eval-eOB-2026-09-10T06:25:07`, and `eval-xpB-2026-09-10T06:25:12`.
The explicit-obligation response passed the semantic rubric but printed its
correct disposition in Markdown bold. The initial exact-line assertion failed.
The disposition assertion now accepts plain or bold lines and still rejects
conflicting labels. Local re-evaluation of the *same saved response* passed;
its already completed semantic grade was retained. Both original RED responses
still fail the updated disposition assertion. This is a harness normalization,
not a new model trial or evidence of prompt improvement.

The existing `evidence-judgment` (5/5) and `remediation-evidence` (5/5) suites
passed. The supplementary `testing-review-observable-evidence` response was
manually checked against its rubric, but its automatic grader returned an API
error. It is excluded from automated pass counts; no replacement model trial
is claimed.

Local checks: build, lint, unit tests, eval contracts, OpenCode probe, and smoke
passed. Light integration initially passed 2459/2460 tests. The remaining MCP
entrypoint test failed because Vite could not resolve a dependency through the
worktree's shared `node_modules` symlink. The original checkout's entrypoint
succeeded; after copying dependencies into the worktree, that same integration
test passed independently. No production-source repair was required.

These tests isolate individual review and adjudication decisions with seeded
reports. They do not measure an entire production remediation loop, every
reviewer, or every provider. One baseline trial per final reproduction and
three changed-policy trials are observations, not a statistical guarantee.

## Second candidate: shared policy refinement

The first candidate did not reliably stop the false positive: testing review
still treated another observation of the same failure condition as a newly
uncovered behavior. The current candidate additionally requires connecting the
claimed gap to a changed operation, handoff, or state transition. Merely using
an existing component from a new caller, or consuming its internal state later,
does not make all of that component's state a new verification obligation.

The fixtures, task inputs, and semantic rubrics remain unchanged. This candidate passed build, lint, and eval contract checks.
After explicit
approval for the external evaluation, adjudication passed 3/3
(`eval-RJf-2026-09-10T06:52:57`) and testing review passed 2/3
(`eval-zT0-2026-09-10T06:53:00`). It was not accepted as GREEN because one
reviewer still required the optional observation.

All three adjudication controls passed again. The additional
`testing-proof-new-behavior` control passed: no test method is specified by the
requirements and no implementation defect is seeded, but the new failure
branch has no representative test. The existing observable-handoff evaluation
also passed after making its Codex grading provider explicit; its earlier
implicit grading API error is not counted as a model failure.

## Third candidate: testing review decision order (reverted)

The shared policy is unchanged from the second candidate. The testing-review
instruction now explicitly applies the shared test-obligation criteria before
comparing detection sensitivity. During follow-up it separates original
requirements and adjudication acceptance criteria from observation methods
added by the latest reviewer. This replaces the ambiguous instruction to find
anything that the change "can break"; it adds no domain-specific exception.
Japanese and English instructions are aligned.

The rendered adjudication prompt was compared with the saved successful
second-candidate input and is unchanged; its policy snapshots are also
unchanged. The revised testing-review instruction passed only 2/3 repetitions
(`eval-KGP-2026-09-10T07:06:47`). It also failed the new-behavior control by
adding the unrelated retry observation as a second mandatory finding. The
observable-handoff control passed. The instruction change was reverted because
it did not reliably improve the target behavior.

## Fourth candidate: align the existing state-evidence criteria

Inspection found an unconditional rule treating final internal state as weak
evidence, including an unconditional unit-test REJECT row. This conflicts with
contracts whose requested behavior is state transition or preservation itself.
The shared review policy and testing policy now distinguish exercising an
operation and observing its required state result from using a state value as
a proxy for a different required effect. Required effects and subsequent
operations still need evidence for those requirements.

This candidate retains the shared test-obligation and finding-tracking rules;
the testing-review instruction is back to the baseline. Both languages are
aligned. Adjudication passed 2/3 (`eval-G5s-2026-09-10T07:15:59`),
while testing review passed 3/3 (`eval-N2b-2026-09-10T07:15:57`). All four
obligation/defect/missing-test controls and the observable-handoff control
passed. This candidate is not GREEN: the failed adjudication expanded the
original immediate selection-state criterion into a later delivery-target
criterion, despite acknowledging that the route was unchanged.

Build, lint, unit tests, eval contracts (31), and the full light integration
suite (159 files, 2460 tests) passed. The earlier integration environment issue
is resolved.

## Fifth candidate: preserve the original acceptance criterion

The shared finding-validity policy now requires recovering the original
subject, inputs/preconditions, evaluation point, and expected result before
matching evidence. A later review cannot substitute another value or usage of
the same concept without independently establishing its mandatory basis.
Both languages are aligned; fixture contents and rubrics remain fixed.

Build and local eval contracts (31/31) passed for this candidate; `git diff
--check HEAD` is clean. Model validation is incomplete. Four evaluation processes (adjudication, testing
review, actual regression, and implicit new behavior) failed during runner
startup with `SQLITE_BUSY: database is locked`; these are harness failures,
not model REDs. Future runs should start suites sequentially to avoid competing
writes to the shared evaluation database. The observable-handoff control
passed. The explicit-obligation evaluation also passed 1/1 with zero errors
(`eval-Kj5-2026-09-10T07:25:33`).

The missing-failure control was rejected by automatic approval review, including
a retry citing the user's earlier approval. No result is available for that
case. The user subsequently explicitly approved transmitting the policies, synthetic
fixtures, and model responses to OpenAI Codex. Evaluation resumed serially.
This candidate must not be described as GREEN or a completed improvement.

The resumed adjudication evaluation (`eval-Io3-2026-09-10T09:27:52`) again
passed 0/3 with no provider errors: all three repair decisions expanded the
original criterion. Inspection of
the actual composed policy revealed a production wiring gap: adjudication
receives `review-adjudication` and `contract-change`, not `review-common`.
Consequently it received the shared evidence rules but none of the added
`finding-validity` rules. In particular, the fifth candidate's new acceptance
criterion rule was absent. Earlier adjudication trials cannot establish the
effect of changes to that unconsumed partial. Testing review does consume it.

## Sixth candidate: connect shared finding criteria to adjudication

Both language variants of `review-adjudication` now include the existing shared
`finding-validity` partial. No domain-specific rule or task instruction is
added. A composition regression assertion requires both actual role snapshots
to contain the shared finding criteria. It failed before the include change
and passed after build (31/31 local eval contracts). This wiring RED is distinct from the original
model behavior RED; model evaluations still need to establish improvement.

The remaining evaluations run suite by suite to avoid SQLite startup locks.


After the wiring change, adjudication passed 3/3 with zero errors
(`eval-Yyb-2026-09-10T09:39:22`). All three responses distinguished the original
failure-state criterion from a proposed subsequent-delivery observation and
confirmed that the actual client does not clear its route for those failures.
Testing review passed only 2/3 (`eval-jnU-2026-09-10T09:47:56`), so the
combined candidate was not accepted as GREEN. The remaining failure equated
an existing related delivery path with a mandatory new observation despite
acknowledging that the current client does not lose state.

Sixth-candidate local checks: build, lint, fast unit (6081 tests), light
integration (2460 tests), and eval contracts (31 tests) all passed.


## Seventh candidate: apply obligation checks before sensitivity checks

The testing-review procedure first separates the original acceptance criterion,
current verification, proposed observation, and that observation's mandatory
basis. It judges the original criterion before adding a proposed condition.
The former instruction about what a change "can break" now explicitly applies
the shared obligation criteria before identifying an undetected failure path.
This adds no fixture-specific exception. Unlike the reverted third candidate,
it runs with the corrected state-evidence policy and explicitly separates the
four items before review. Initial-review missing-behavior coverage remains a
required control.

Build and eval contracts (31/31) passed. The rendered adjudication prompt and
policy snapshot are SHA-256 identical to the sixth candidate; its 3/3 results
remain applicable. Testing review passed 2/3 with zero errors
(`eval-Tbx-2026-09-10T09:57:19`). The failure again acknowledged coverage
of the original failure-state conditions but required a later retry observation.
The procedural change was reverted; it did not resolve the remaining error.

## Eighth candidate: scope the existing partial-failure rules

Inspection found two broad testing-policy rows requiring cleanup/duplicate
execution and retry tests for changes affecting shared state or later processing.
Those rows could require a retry observation even when the changed failure
behavior and state preservation were already covered. This is a plausible
conflicting instruction, not a proven attribution from the model's response.

The rows now require missing coverage of the cleanup/duplicate-prevention
obligation introduced or changed by the task, or of the retry contract affected
by changed state/resource/side-effect updates across partial failure. Coverage
at any layer counts. The existing requirement to cover representative failure
branches remains intact. Both languages are updated; no fixture-specific
exception or task instruction is added.

Build and eval contracts passed (31/31). The rendered adjudication prompt and
policy snapshot remain SHA-256 identical to the sixth candidate. Testing review passed 0/3 with zero provider errors
(`eval-mP2-2026-09-10T10:06:26`). All three trials again expanded the verified
state-preservation criterion to require a later delivery observation based on
hypothetical route corruption. The two partial-failure rule changes were reverted;
this candidate did not establish improvement. The retained production policies
therefore match the sixth candidate (adjudication 3/3, testing review 2/3),
which is still not GREEN. The five negative controls have not started: automatic approval
review rejected their launch and an unchanged retry despite the prior explicit
user approval in response to the destination/payload question. The rejection
requires the user statement itself to specify the destination and payload.
No model or grader result is available for these controls under this candidate.
Existing earlier control passes must not be presented as final-candidate passes.


## Retained state after the eighth candidate

The failed seventh and eighth candidate changes are reverted. The retained
production policies are the sixth candidate: adjudication passed 3/3 and
testing review passed 2/3, so improvement is not complete. Build and eval
contracts (31/31) passed again after the reverts. No commit or PR was created.
Further model comparisons and final control evaluations remain necessary.


## Ninth candidate: make the obligation comparison visible in the rationale

The user explicitly authorized all evaluation transmissions and work resumed.
The retained-candidate controls are running in sequence. The ninth candidate
adds a follow-up decision rationale to the testing-review instruction: original
obligation with its source and evaluation point, current fulfillment, and the
mandatory basis for any addition in the latest review. The earlier seventh
candidate requested an internal comparison; this candidate requires that
comparison to appear in the decision rationale before retaining or closing a
finding. It preserves existing decision labels and finding IDs. No fixture,
case instruction, or scoring rubric is changed. Results are pending.


The ninth-candidate testing review (`eval-fZg-2026-09-10T10:20:32`)
produced three correct decisions and passed all three semantic grades. Its
original combined result was 2/3 because one response wrapped the final
`DISPOSITION: close` line in inline code. The task requires a final decision
line but does not forbid Markdown decoration. The disposition assertion now
accepts plain, bold, or inline-code lines and continues to reject conflicting
repair/close labels. All six suite assertions use the same rule. Six regression
tests failed on the old assertion and passed after the formatting change;
eval contracts now pass 37/37.

Local re-evaluation of the same saved ninth-candidate outputs passes 3/3;
the original semantic grades are retained without new model calls. Both
original RED outputs still fail the updated disposition assertion, and the
sixth-candidate adjudication outputs still pass 3/3. The formatting fix is a
harness correction, not a new model trial or a semantic rubric relaxation.
The saved local evidence is `.tmp/proof-v9-saved-response-rescore.json`.

The explicit verification control passed 1/1 with no errors
(`eval-m2n-2026-09-10T10:19:02`), citing the explicit missing retry test
without inventing a current implementation defect. Other controls are pending.
The three adjudication controls use unchanged sixth/ninth-candidate inputs.
The two testing controls are prepared after the ninth-candidate build and
must be checked for that instruction in their actual prompt inputs; artifact
filenames retain the launch-time suffix `retained-v6`.


The current-defect control passed 1/1 with zero errors
(`eval-UzY-2026-09-10T10:24:30`). It closes the original failure-state test
gap and separately requires repair of the unconditional route clearing and a
regression test for the confirmed subsequent-delivery defect. It preserves
the distinct finding IDs and does not exempt a real defect as optional proof.


The missing-failure control passed 1/1 with zero errors
(`eval-QOQ-2026-09-10T10:32:00`). It requires tests for the untested new
failure branches even though the implementation appears correct, and does not
expand the repair into internal-state or later-delivery tests. The subsequent
new-behavior control's prepared prompt contains the ninth-candidate rationale
instruction, confirming that the launch-time filename suffix does not mean
it used the old instruction.


The first new-behavior control attempt (`eval-Xku-2026-09-10T10:38:45`)
correctly required the missing failure tests but also required a retry test for
unchanged retired-route behavior, so its semantic grade failed. Inspection
revealed that the supposedly initial-review control used the `reviewers`
follow-up branch. The response explicitly noted this incorrect mode. This
trial is excluded as an invalid composition trial; it is not counted as either
model RED or final-control success. Earlier runs of this control have the same
mode limitation and do not establish initial-review behavior.

The target now uses `initial-reviewers`, matching the existing observable-
evidence suite. A rendered-mode regression assertion failed before the fix.
The fixture, case instruction, production facets, and grading rubric remain
unchanged. The corrected control must pass a fresh model evaluation.


The existing observable-handoff suite passed 1/1 with zero errors
(`eval-D6x-2026-09-10T10:46:43`). Its saved evaluated prompt includes the
ninth-candidate instruction and initial-review mode. It identifies the real
`timeoutMs` propagation gap through `execute()` while accepting already-covered
`traceLabel` behavior without requiring duplicate per-module assertions. This
existing suite uses its original Codex SDK provider; the six new suites use
Luna Max. The initial-mode harness fix passes all 38 local eval contracts.


## Tenth candidate: apply visible scope reasoning to initial review

The corrected initial-mode control (`eval-NDF-2026-09-10T10:48:54`) was
reported as an automated pass, but manual inspection found the same unwanted
mandatory test for unchanged `ROUTE_RETIRED` behavior, including a subsequent
send. It is not accepted as a successful control. The semantic grader missed
a violation of the existing no-extra-retry requirement. The rubric now
explicitly covers that unchanged legacy path; this tightens the existing
criterion and does not change the fixture or expected repair disposition.

The testing instruction now also asks initial reviews to record the changed
operation/handoff/state rule, its untested condition, and the mandatory basis
for the test. A restated existing contract or mere call-path membership is not
sufficient. Explicit obligations and real defects remain actionable. The
successful follow-up rationale is retained unchanged. Both languages are
aligned. Fresh testing-review target and control results are required.


Tenth-candidate build and eval contracts (38/38) passed. Actual composed
prompts were checked: the optional-proof target is `follow_up`, while the
new-behavior and observable-handoff controls are `initial`; all three contain
both rationale sections. The observable-handoff control passed again with
zero errors (`eval-yzE-2026-09-10T10:59:21`), and manual inspection confirms
a focused timeout propagation finding without duplicate trace-label tests.


The tenth-candidate follow-up target passed 3/3 with zero errors
(`eval-2Y9-2026-09-10T10:59:04`). Both disposition and semantic assertions
passed directly on every fresh response; no saved-output rescore was needed.
Manual inspection confirms that all three distinguish the original failure-
state criterion from the later retry observation and preserve the existing
finding ID. Latest lint also passed. The corrected initial-review control
remains pending.


## Eleventh candidate: include the obligation in the mandatory test gate

The tenth-candidate initial control failed (`eval-ebP-2026-09-10T10:58:39`):
it still mapped a new caller to an unchanged component's retirement behavior
and required that component's retry test. The added initial-review rationale
was ineffective and is reverted; the successful follow-up rationale remains.

The existing four-part mandatory-test gate required a contract, reachable
failure, missing detection, and owning layer, but did not itself require a
basis for adding that verification in the current task. Although separate
scope rules exist, this is a plausible competing instruction; model causation
is not proven. Both testing and common-review gates now explicitly require a
fifth fact: the current verification obligation. Testing policy determines
that obligation at the owner and condition being observed, distinguishing a
new consumer's handoff from unchanged conditions inside its dependency.
Explicit obligations, changed behavior, and real defects remain sufficient.
Both language variants are aligned. Fresh model evaluations are pending.


The eleventh-candidate new-behavior control passed 1/1 with zero errors
(`eval-otn-2026-09-10T11:12:10`). Manual inspection confirms a single
required finding for the new failure branches; unchanged retirement behavior
is explicitly excluded from mandatory work. The observable-handoff control
also passed 1/1 with zero errors (`eval-uU8-2026-09-10T11:12:50`), with a
focused timeout propagation finding and no duplicate trace-label tests.
All five controls now have valid passes. Repreparing the three adjudication
controls confirms that both their prompts and policy snapshots are SHA-256
identical to their passed inputs. The fresh follow-up target is still pending.


## Twelfth candidate: preserve original conditions in a comparison table

The eleventh-candidate follow-up target passed 2/3 with no provider errors
(`eval-MEt-2026-09-10T11:12:28`). The remaining response described the
original criterion as "mostly" fulfilled, then used an added later observation
as an unmet part of that criterion. The candidate is not accepted as GREEN.

The follow-up instruction now records the original source, operation/state
owner, input, evaluation point/result, current evidence, and fulfillment in
a comparison table. A retained finding must identify the original unmet row;
an added observation cannot be placed in that row's unmet reason. Added
obligations are still assessed separately against the shared criteria. This
replaces the looser prose comparison rather than adding domain-specific rules.
The eleventh-candidate obligation gate remains. Fresh testing-role results
are pending; adjudication inputs remain unchanged.


## Thirteenth candidate: record source-backed refutation

The twelfth-candidate target (`eval-ulp-2026-09-10T11:23:10`) closed the
finding in all three trials, but passed only 1/3 semantic grades. Two responses
correctly declined the extra retry demand yet omitted an explicit source-backed
check that the current client does not clear state for the target failures.
The rubric is unchanged; these responses are not accepted as full passes.
Both testing controls passed, including manual inspection of the initial
control (`eval-cZK-2026-09-10T11:23:31`) and observable-handoff control
(`eval-4bK-2026-09-10T11:23:51`).

The comparison procedure now also requires source-backed refutation when
rejecting an added requirement: the operation's actual execution condition and
whether the target input/path satisfies it. Unknowns cannot prove absence.
The procedure is extracted to a dedicated instruction partial, included from
`testing-review-focus` so both direct and composed workflows receive it. The
worksheet is fenced as an embedded instruction output template. An actual
composition assertion guards this include. The thirteenth candidate is freshly
evaluated after extraction and formatting; earlier testing-role results are
not reused as identical-input results.


## Fourteenth candidate: separate authoritative conditions from review claims

The thirteenth-candidate target passed 2/3 with zero provider errors
(`eval-m0t-2026-09-10T11:39:15`). The failed response inserted a retry
condition sourced from the latest testing report into its original-condition
table, despite marking the actual adjudicated failure-state condition fulfilled.
This remains a real semantic failure, not a formatting or grading issue.
Both controls passed and were manually inspected: initial new behavior
(`eval-fCz-2026-09-10T11:39:56`) and observable handoff
(`eval-aPK-2026-09-10T11:40:13`).

The comparison instruction now explicitly distinguishes requirements and
adjudication from review reports containing claims to evaluate. A table row
must actually occur in its cited authoritative source. Conditions appearing
only in a review report are evaluated separately, using requirements, diffs,
or current code independent of that report's own assertion. This preserves
newly discovered defects and genuine test obligations while preventing a
review's repetition of its own demand from establishing that demand. No
fixture, task, rubric, policy, or disposition contract changes in this candidate.
Fresh testing-role evaluations are pending.


The fourteenth-candidate follow-up target passed 3/3 with zero provider errors
(`eval-X6S-2026-09-10T11:48:48`). All responses were manually inspected:
they resolved the original finding using the existing failure tests, rejected
the later retry demand as an added observation, and checked current code for
the alleged state loss. The observable-handoff control also passed 1/1 with
zero errors (`eval-TsV-2026-09-10T11:49:29`), retaining the actual timeout
propagation issue without demanding duplicate trace-label tests. The initial
new-behavior control also passed 1/1 with zero errors
(`eval-Hnw-2026-09-10T11:49:08`). Manual inspection confirms that it requires
the new temporary-failure tests and excludes unchanged retirement behavior
from mandatory work. All five final controls pass.


Final verification confirms the adjudication target prompt and policy snapshot
are SHA-256 identical to the sixth-candidate 3/3 inputs. The three adjudication
controls remain identical to their passed retained-input trials
(`eval-m2n-2026-09-10T10:19:02`, `eval-UzY-2026-09-10T10:24:30`,
`eval-QOQ-2026-09-10T10:32:00`). No rerun is claimed for those unchanged inputs.
The final testing target artifact is `.tmp/proof-testing-green-v14.json`; the
initial and observable controls are `.tmp/testing-proof-new-behavior-v14.json`
and `.tmp/testing-review-observable-evidence-v14.json`. These local artifacts
are untracked. This record preserves unsuccessful trials rather than reporting
only the final passing candidate.
