```markdown
# Review Finding Decision

## Result: Problems require repair / No problems require repair / The entire task must be replanned

## Decision Summary
{Reports inspected, number of problems to repair, number of findings not selected for repair, and key evidence}

## Inherited Problem Status
| Problem ID | Original Acceptance Criteria | Current Status | Adopted Results and Target Code State | Checks or Conflicts Remaining to Determine Resolution Status |
|------------|------------------------------|----------------|---------------------------------------|-----------------------------|
| {Existing ID} | {Subject, input, evaluation point, expected result} | {Resolved / Unresolved / Unverified / Awaiting external confirmation / Outside this task} | {Independent verification or latest review source and correspondence to criteria} | {None, or conditions whose resolution status cannot be established from corresponding records, remaining checks or conflicts between records, and reasons; removed criteria and reasons} |

## Problems to Repair
| Problem ID | Related Findings | Violated Condition | Cause | Relevant Paths | Evidence | Acceptance Criteria | Repair Boundary |
|------------|------------------|--------------------|-------|----------------|----------|---------------------|-----------------|
| {Existing problem ID, or a new ID} | {All finding IDs and report names} | {Condition required by requirements, contracts, or quality standards} | {Verified cause; for existing problems, repair regression distinction and evidence only when established by the latest repair report and verification records, the path identified by the finding, and the current code} | {Paths, contracts, and results checked to establish premises needed for acceptance} | {file:line or reproduction evidence; the item establishing applicability of inputs and states and the location of supporting documentation, code, or records} | {Inherited criteria, or new conditions that establish resolution when all hold} | {Required changes; reference to the inherited plan, its established method, applied portions, and remaining work; whether method reconsideration is needed and why; matters for repair planning to investigate; explicitly excluded separate problems} |

## Fixed-Version References
| Problem ID | Execution Identity and Order | Plan, Repair, and Verification References | Missing or Incomplete Records |
|------------|------------------------------|------------------------------------------|-------------------------------|
| {Existing ID, or correspondence unverified} | {Supplied identity and order} | {Copy supplied fixed paths and existing references as source information} | {Supplied status, no history, or uncertain correspondence} |

## Decision for Each Finding
| Finding ID / Source | Technical Check | Treatment in This Task | Problem ID | Reason and Evidence |
|---------------------|-----------------|------------------------|------------|---------------------|
| {ID and report name} | {Confirmed / Disproved / Unverified} | {Repair / Merge into same problem / Unsupported / Unnecessary expansion / Outside this task / No issue after verification / Cannot verify in this environment / Awaiting external confirmation / Carry forward} | {Problem ID or none} | {Reason grounded in requirements, specifications, the threat model, and finding evidence; correspondence to Unresolved Premises or Cannot Verify in This Environment when acceptance or acceptance criteria remain undecided} |
| {Source report and item recorded as a carried-forward plan caveat, plus the finding ID if resubmitted} | {Confirmed / Disproved / Unverified} | {Repair in this round / Carry forward / Reject} | {Problem ID or none} | {Carry-forward record, decision evidence and, if carried forward, the next responsible stage} |

## Guarantees Not Adopted
| Decision Source | Guarantee or Method Not Adopted | Reason and Applicable Scope | Relationship to Current Findings | Conditions for Reconsideration |
|-----------------|---------------------------------|-----------------------------|----------------------------------|--------------------------------|
| {Original decision source recorded in the supplied previous adjudication, supplied human decision, or current adjudication source} | {Guarantee, input restriction, or proof method not added} | {Requirements or existing contracts, impact on normal use, and scope of the decision} | {Finding ID or plan caveat and whether this is the same proposal or a distinct problem; none if not resubmitted} | {None, or new evidence or requirement change invalidating premises and the decision needed} |

## Awaiting External Confirmation
| Problem ID | Unverified Acceptance Criterion | Requirement Basis | Repairs and Verification Completed in This Environment (Including Target Code State) | Where and How to Confirm | Evidence Needed to Decide |
|------------|---------------------------------|-------------------|-------------------------------------------------------------------------------------|--------------------------|---------------------------|
| {Existing problem ID} | {Remaining unverified criterion} | {Location in requirements or existing contracts} | {Completed repairs, necessary verification and successful results, target commit or code state} | {Why only externally observable, confirmation destination and procedure} | {Result establishing acceptance criterion fulfillment} |

## Cannot Verify in This Environment
| Finding ID / Source | Unverified Condition | Why It Cannot Be Verified in This Environment | Evidence Needed to Decide |
|---------------------|----------------------|-----------------------------------------------|---------------------------|
| {ID and source} | {Condition still needed to confirm or disprove the defect} | {Why the external environment cannot be provided and alternative evidence does not settle the matter} | {External observations or information needed to confirm or disprove the defect} |

## Unresolved Premises
| Finding ID / Source | Established Facts | Undecided Matter Needed to Determine Acceptance or Acceptance Criteria | Next Check or Decision Needed | Recipient |
|---------------------|-------------------|------------------------------------------|-------------------------------|-----------|
| {ID and source} | {What is established} | {Undecided premise and why acceptance or acceptance criteria cannot be determined without checking it} | {Factual investigation or requirement decision needed to settle it} | {Repair planning / Replanning} |
```

- Record every submitted finding ID exactly once in Decision for Each Finding
- Include rows from Non-Finding Concerns (Unverified Scope in testing-review) in the report only when their Classification column is plan-caveat-carry-forward. Omit explanations of all other rows from the report
- Record problems accepted through adjudication in Problems to Repair. Do not copy an item from history as an accepted problem merely because it appears there
- Omit Problems to Repair when no repair is required
- Carry the source, reason, and applicable scope of each entry in the supplied previous decision's Guarantees Not Adopted into this section even when the latest review does not resubmit that guarantee. Identify the decision maker from the recorded source; inclusion in a previous adjudication alone does not make it a human decision. Also record supplied human decisions and guarantees or methods declined in this adjudication. If revising an entry, state the changed requirement, new concrete evidence defeating its premise, or the new case's relationship to its applicable scope. Omit this section when no such decision is supplied or made. Another run can carry it forward only if this report is supplied as an input

- Omit Awaiting External Confirmation and Cannot Verify in This Environment when there are no corresponding items
- When the entire task does not need replanning and there are no problems to repair or factual investigations to decide acceptance that can proceed within the current scope, select No problems require repair. This includes cases where only items awaiting external confirmation or unverifiable in this environment remain

- In Unresolved Premises, record the checks and recipients needed to settle findings whose acceptance or acceptance criteria remain undecided and for which factual investigation can proceed within the current scope or task-wide replanning is needed
- Omit Unresolved Premises when there are no such items
- When the entire task does not need replanning and there are problems to repair or factual investigations needed to decide acceptance that can proceed within the current scope, select Problems require repair
- When the entire task must be replanned, including decisions about protection obligations or repair scope, select The entire task must be replanned
