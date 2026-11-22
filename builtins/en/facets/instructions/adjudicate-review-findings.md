Adjudicate submitted review findings against the requirements and threat model, and establish acceptance criteria and repair boundaries for problems to repair in this task.

## Establish the Items to Adjudicate

List finding IDs by submitting source from the currently available review reports. Include plan caveats and items inherited from the previous decision, and associate each item with its source and previous treatment. Use repair and verification reports as evidence for decisions.

To carry plan caveats into adjudication, include items in "Caveats" ("Open Questions (if any)" in a regular plan) and items recorded as "carried forward as a plan caveat." For "Non-Finding Concerns" ("Unverified Scope" in testing-review), include rows whose Classification column is "plan-caveat-carry-forward." Reviewers record carry-forward in this column, so the row's Classification column establishes whether it is a target. Proceed with the decisions below for the targets established here.

Consult background material where a target finding has an undecided matter that could change acceptance and the material is needed to establish that matter.

## Decide Each Finding

{{include:instructions/review-adjudication-check}}

## Match Existing Problems and Repair Plans

Match each finding's cause, violated condition, and acceptance criteria to problems in previous decisions or repair plans in progress. For a corresponding problem, use the supplied decision, plan, repair, and verification records to organize the established method, applied and verified portions, and remaining work, associating them with problem and finding IDs and sources. If those records do not settle the merge destination or carry-forward, check the necessary portions of the corresponding fixed-version references. When no plan is in progress and a problem previously considered repaired recurs within the applicable scope, with a confirmed common mechanism violating the same condition, also record whether reconsideration of the method is needed and why. Where reconsideration is needed, identify the mechanism linking the previous repair to the new counterexample, conditions to preserve, and conflicts with requirements. Pass the inherited plan and remaining work to repair planning.

## Establish the Current State of Inherited Findings

Separate the previous acceptance decision from current resolution status. Independent verification is responsible for checking whether the repair met the original acceptance criteria. In adjudication, match the independent verification or latest review records to the current state of the relevant implementation and configuration and to the subject, input, evaluation point, and expected result of the original acceptance criteria. Results in corresponding records establish the current resolution status. Where conditions conflict between records, check the locations that determine those conditions. Matters confirmed by corresponding records do not become unresolved merely because the adjudicator has not repeated the checks.

Record acceptance and resolution separately; do not treat resolution by repair as disproof of the original finding. Match the original acceptance criteria to requirements and existing contracts, compare necessary in-environment verification results, causes of external failures, and remaining checks, and record current resolution status and remaining work. When removing an acceptance criterion, preserve the original criterion and the reason for removal as "Outside this task."

{{include:instructions/preserve-acceptance-conditions}}

When revisiting acceptance, associate the immediately preceding decision with the new evidence and apply the following exception.

{{include:output-contracts/base-review-reopened}}

## Return the Result

Associate every finding ID with its decision and merge destination. For inherited caveats, record repair in this round, carry forward, or rejection and the reason. Pass factual investigations still needed to determine acceptance or acceptance criteria that can proceed within the current scope to repair planning, and task-wide decisions about protection obligations or repair scope to replanning, stating what needs to be checked. For findings that cannot be verified in this environment, record and carry forward the unverified conditions, why they cannot be verified in this environment, and evidence needed to decide.

Preserve access to original records by copying supplied fixed-version plan, repair, and verification references and existing decision references, including execution identity, order, and missing or incomplete status. Distinguish current reports from history lists. Copy references from the supplied information; consult their contents as needed to decide acceptance or correspondence with inherited results. Preserve missing records as missing for that version.

Return the result with decisions for all targets, acceptance criteria, repair boundaries, and unresolved matters.
