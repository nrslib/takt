# Review Finding Adjudication

Accept bugs that hold in fact and violate specifications, requirements, or existing contracts within the required threat model, regardless of their relation to the current work or plan. For portions caused by a secondary environment, distinguish obligations to support or verify that environment from regressions in previously working paths. Resolve remaining gaps in existing problems by carrying forward those problems and their plans in progress.

## Adjudication Criteria

| Criterion | Decision |
|-----------|----------|
| Does it hold in fact? | Confirm that the claimed failure or structural violation actually holds in the current code, accounting for the effect of existing defenses |
| Is the scope of improvement or addition appropriate? | Judge quality or design improvements and refactoring by their relation to the current requirements or changes. Include feature additions and specification changes grounded in the requirements. Bug fixes are included even when unrelated to the current work or plan |
| Is it within the threat model? | The inputs, states, authority, concurrency, and volume needed for the failure must fall within the scope required of this system |
| Does the exclusion from protection still apply? | Treat a finding that only requests such protection as unnecessary expansion when pre-change documentation or knowledge explicitly excludes the actor and method, the requirements do not change that exclusion, threat actors, activation and consent conditions, input scope and interpretation or execution, effective authority and credentials, and reachability of protected assets remain unchanged, and existing defenses are neither bypassed nor omitted |
| Separate the defect from the proposed repair | If the defect is valid but a proposed transaction, limit, compatibility path, or other mechanism is excessive, accept only the defect for the minimum necessary repair and reject the excessive method |

Judge bugs by factual validity, violation of specifications, requirements, or existing contracts, and applicability of the threat model. Also apply the scope criterion to quality or design improvements and proposed additions. To make the basis for acceptance or rejection clear, check whether each criterion is met: accept findings meeting the criteria even when they appear small, and reject findings with an established failure to meet a criterion, citing that criterion as the reason. Retain undecided findings as unresolved to distinguish them from confirmed counterevidence. Severity, finding counts or votes, preferences, discovery timing, and coverage of other perspectives do not decide acceptance. Explain decisions in terms of facts, the condition to preserve, the threat model, and, for improvements or additions, their relation to the current requirements or changes. An incorrect line number or path description alone does not disprove the same defect established at the correct location.

## Task Scope and Repair Boundaries

Apply quality and design standards to improvements and refactoring related to the current requirements or changes. Cleanup of duplication in existing code unrelated to the current change is outside this task. Structural defects require a specific violation of an applicable standard; a measured incident or attack scenario is not a universal prerequisite. For bugs, neither absence from a past plan nor lack of a causal relation to the plan is a reason for rejection.

For paths added or modified by the current change that handle data whose count or size is not bounded by requirements, schemas, or documentation, judge whether retrieval or simultaneous retention needs to grow in proportion to the entire dataset. Accept unnecessary retrieval of all items or simultaneous retention of all items as a design defect when the retrieval scope or simultaneous retention can be reduced while preserving the required results, even without numerical limits, SLOs, or measured incidents.

For processing that requires scanning all inputs, judge the necessary total retrieval and processing separately from the need for simultaneous retention. Account for the bound on a small fixed collection and the effect of an effectively bounded buffer on simultaneous retention; judge processing that requires holding the entire input at once based on that necessity. When all items must be output, distinguish adding a limit that truncates the output from processing incrementally to reduce retention while preserving the output, and accept defects that the latter can resolve.

Current behavior alone does not establish an existing contract that must be preserved. To distinguish intended specification changes from contract violations, preserve existing contracts that remain binding after replacements explicitly required by the requirements. Allow the choice of repair method within the methods mandated by the requirements and necessary safety conditions, and accept the minimum repair that resolves the defect.

## Carrying Forward Existing Problems and Plans

To carry forward current problems and complete plans in progress, determine the merge destination of submitted findings by prioritizing correspondence with problems in the previous decision and repair plan in progress. Determine current resolution status by matching the latest repair and verification records for that problem's acceptance criteria to the current code. Consult only the necessary portions of records from earlier rounds as supplementary evidence when those materials do not settle the merge destination or carry-forward. Do not reconstruct the course of events.

When a finding has the same cause, violated observable condition, and acceptance criteria as a problem in a previous decision or a repair plan in progress, treat it as an unfinished part of that problem even when the location or input differs, preserving its ID, acceptance criteria, and the method established by the plan. If the failing path is established to have been newly added by a repair, distinguish it as a repair regression and record that the path did not originally exist, with evidence. Otherwise, record no distinction and treat it as remaining work on the same problem. Add newly confirmed locations, paths, and evidence to the original finding IDs and sources. Treat findings as separate problems when their cause, violated condition, or acceptance criteria differ.

When application or verification of a plan to eliminate the common cause is in progress, carry forward unwired paths or missing verification as remaining work needed to complete that plan. Preserve the authoritative implementation and method already connected and verified. When no plan is in progress and a problem previously considered repaired recurs within the applicable scope, with a confirmed common mechanism violating the same condition, determine that the method needs reconsideration. If recurrence and the common mechanism cannot be confirmed, treat the finding as ordinary cause analysis without discussing whether reconsideration is needed. Separate the need for reconsideration from choosing a new method, and pass the evidence and conditions to preserve to repair planning. If a mandated method or required condition conflicts with reconsideration, state the conflict and the requirement decision needed.

## Secondary Environments and Acceptance Criteria

Judge each environment by its role in documentation, knowledge, or requirements and by the requirements or pre-change user-facing support contract. Apply an explicitly requested change to that support contract. If the same cause also affects primary environments, include those repairs normally.

Determine obligations to support or verify an environment from the requirements and the promises made for the affected feature in pre-change user-facing documentation. A general feature requirement that does not exclude an environment, its secondary status, a corresponding CI job, or an implemented path alone does not establish a promise of support or verification there. Judge a promise of support separately from an obligation to verify in that environment. To settle obligations for additional support or verification, check whether pre-change user-facing documentation makes the relevant promise; if it makes no such promise, close the decision on additional support or verification claimed on that basis as outside this task.

| Criterion | Decision |
|-----------|----------|
| Failure is caused by a secondary environment, neither the requirements nor the pre-change support contract requires support or verification there, and the current change caused no regression | Distinguish it from regression repairs and treat it as outside this task. Additional support for that environment, a pre-operation error, and documentation receive the same treatment, including when a new feature fails only there |
| Neither the requirements nor the pre-change support contract requires support or verification there, but the current change broke a previously working path in a secondary environment | Include repair, with acceptance criteria limited as described below |
| The requirements or pre-change support contract requires support or verification there, or the cause is a configured default, rejection by a dependency, or another cause rather than an environment-specific constraint | Apply the ordinary adjudication criteria |

For a regression in a secondary environment with no obligation of support or verification, limit acceptance criteria to implementation based on official specifications and repairs verifiable by tests runnable in this execution environment, such as mocks or reproduction of inputs conforming to the specifications. Do not include testing on an actual system in the affected environment or running tests on that environment's CI runner as acceptance criteria.

If that implementation itself cannot be done here, require an error explaining why the affected environment is unsupported before any processing with side effects, together with user-facing documentation of the limitation. Stopping with an incidental exception after changing state does not meet this condition, even if the main operation has not started. Record full support as outside this task with the reason. Inability to perform testing on an actual system alone does not establish that the implementation itself cannot be done here.

If verification in a secondary environment has no basis in the requirements or pre-change support contract, treat it as outside this task and remove it from acceptance criteria, repair targets, and pending external confirmation. Even if a previous decision made it an acceptance criterion, preserve the original criterion and the reason for removing it. Restoring that criterion later requires a basis in the requirements or pre-change support contract.

## Pending External Confirmation and Remaining Work

Separate the acceptance decision from current resolution status, and determine treatment from the work still needed to fulfill acceptance criteria. Pending external confirmation is permitted only after repairs and necessary in-environment verification are complete, with both a basis for the remaining verification condition itself and a reason why it can only be observed externally. A verification method, CI job, implemented path, or condition in a previous decision alone does not justify making that verification an acceptance criterion.

| Criterion | Decision |
|-----------|----------|
| Repairs and necessary in-environment verification are complete against the current code state, and no acceptance criteria remain outstanding | Mark the problem resolved, preserving the original acceptance decision, problem ID, and history |
| Repairs are complete, in-environment verification required to fulfill acceptance criteria has succeeded against the current code state, and there is a specific reason why the remaining grounded conditions can only be observed externally | Mark the remaining conditions as awaiting external confirmation. When only external confirmation remains, no problem requires repair |
| Repairs are incomplete, or necessary in-environment verification is unperformed, failed, or from an older version | To establish the work needed to fulfill acceptance criteria, retain necessary repair, verification, or cause investigation as remaining work. Distinguish verification status from the presence of a code defect, requiring evidence of a failure or structural violation to establish a defect |
| An external failure result demonstrates an acceptance criterion violation caused by the current code for the same input and expected result | Return the problem to repair under its existing ID. Separate failures of external equipment or services and other failures not caused by code from implementation repairs |
| The external environment needed to confirm or disprove a defect cannot be provided through repository implementation, configuration, or test preparation, and available alternative evidence cannot settle it | To show that evidence is insufficient to confirm or disprove the defect, record that it cannot be verified in this environment, with the unverified conditions and necessary evidence |

## Missing Verification or Artifacts

Judge missing verification or artifacts by their connection to explicit obligations, regression protection for changed behavior, or confirmed defects. Ground the decision in the condition to preserve, the failure to detect, and why existing verification or artifacts cannot fulfill it, and set acceptance criteria for the smallest layer that detects that failure and the necessary scope. Even correct implementations may require explicitly mandated verification or missing necessary regression checks.

Judge obligations to update artifacts or verify regressions separately from proposed automated checking methods or additional guarantees. Judge counterexamples to verification aids by whether they prevent confirmation of the original required conditions. Broader checks or additional observation methods require evidence of their necessity.

## Past Process Deviations

An irreversible past process deviation alone does not justify repair, but only when the deviation has stopped, no effects remain in artifacts or external state, and the current code has been verified under the specified conditions. Judge remaining effects, necessary verification, and violations of confidentiality, external-operation, or authority boundaries normally.
