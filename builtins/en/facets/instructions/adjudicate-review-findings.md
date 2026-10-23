Verify each specialist reviewer report in the Report Directory, adjudicate unresolved concerns and omissions within its assigned perspective, and determine which repairs are authorized now.

Keep supplied current reports distinct from history lists. Read earlier repair plans, results, and verification from the fixed paths in those lists. Compare documents with matching execution identities, and do not fill incomplete or missing entries with another version.

{{include:instructions/review-adjudication-check}}

Do not add a new specialist perspective. Treat each reviewer report currently available under the Report Directory as a submission. Carry forward findings decided in earlier rounds from the existing adjudication. For each inherited Repair problem, check every round whether repairs to current code and necessary in-environment verification are complete. If complete and only external confirmation remains, remove it from repair targets and move it to Awaiting external confirmation under the external-confirmation criteria. If the remaining confirmation has no basis in requirements or existing project contracts, treat it as Outside this task. Compare each confirmation in earlier adjudications with the relevant part of the requirements or existing project contracts. Do not carry it forward as a repair target merely to preserve the previous decision. Then newly decide only unresolved concerns in current reports and omissions confirmed within a submitting reviewer's assigned perspective. Inspect current code, requirements, plans, and execution evidence only as needed to decide those submissions.

For each concern, evaluate the technical claim, concrete failure condition, evidence, and reason remediation is required now separately. For every accepted remediation target, record that reason, the violated observable condition, affected contract paths, acceptance criteria, and repair boundary.

Before selecting a finding for repair, or before setting acceptance criteria, check the following points about the inputs, states, and quantities the finding assumes.

- Who can choose the input values, and which process reads them?
- Which processes operate on the same resource simultaneously?
- What counts and sizes are assumed?

Locate the requirements, documentation, code, or records supporting each premise.

Use earlier decisions and history to avoid readjudicating decided concerns and to match problems with the same cause, violated condition, and acceptance criteria. Do not treat repair history or completion verification alone as sources of submitted concerns; adjudicate unresolved concerns submitted by reviewer reports.

Separately from adjudicating new findings, read the plan report's "Caveats" (items carried forward under "Open Questions (if any)" in a regular plan) as known items. Cover both items a reviewer submitted as findings and items recorded under the review report's "Non-Finding Concerns" (or "Unverified Scope" in testing-review) as "carried forward as plan caveats", including those not submitted by a reviewer, and explicitly adjudicate each as "Repair in this round / Carry forward / Reject" with evidence. Even if a reviewer resubmits one as a new finding, treat it as reevaluation of a known item and retain decisions on previously adjudicated findings unless the `reopened` conditions below are met.

Treat a caveat as "Repair in this round" only when it is promoted to a finding under the existing finding criteria for defect evidence and scope; otherwise record it as "Carry forward" or "Reject".

Apply the following shared definition to exceptions that allow readjudicating previously decided findings.

{{include:output-contracts/base-review-reopened}}

Record a complete decision for every submitted concern and every omission confirmed during verification, together with the consolidation target for concerns with the same cause. Base the result on current evidence and the adjudication criteria rather than reviewer vote counts. When a concern cannot be decided, state the unresolved premise instead of excluding it by assumption.
