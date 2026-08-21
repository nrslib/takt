## Problem-Family Completion Sweep

`family_tag` is only an aid for exploration and aggregation. Establish family identity from the responsible source, observable invariant, and reason to change from the same cause; only after those fields match may an existing `family_tag` be reused and the added path recorded in the same row. Do not use the tag itself to establish finding identity, `persists`, `reopened`, or `duplicate` status, recurrence, or a REJECT decision. Base those judgments on the latest `review-resolution.md`, current evidence, and finding records.

| family_tag / changed contract | Responsible source | Observable invariant | Contract authority | Reason to change from the same cause | Added path | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, fallback, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|--------------------|----------------------|--------------------|--------------------------------------|------------|------------------------------------|---------------------------------------|------------------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {single responsibility and source that defines the invariant and guarantees it holds} | {condition to preserve} | {original requirement, acceptance criterion, public specification, or real consumer dependency} | {why the paths need to change for the same cause} | {new path checked in this review, or none} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

### Terminal Results by Input, State, and Path

Record one row for every concrete condition distinguished by the review. Conditions with the same contract judgment and terminal result may be combined when the evidence for doing so is stated. When no condition was distinguished, record "not applicable."

| family_tag / changed contract | Entry, input, precondition | Dependency outcome or reached branch | Expected terminal result | Actual terminal result and evidence | Check result |
|-------------------------------|----------------------------|--------------------------------------|--------------------------|-------------------------------------|--------------|
| {problem family or contract reviewed} | {concrete condition that changes the contract judgment} | {specific real outcome such as success, absence, rejection, or exception} | {return, state, side effect, or exit status} | {actual result and file:line, or reason unchecked} | {no issue / finding number / unchecked} |
