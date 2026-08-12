Center the review on closure of open findings and inspect their repair sites and directly affected paths. Perform bounded horizontal comparison to find the common owner, duplicate implementations, and unvisited or unmigrated consumers within an accepted family, but do not expand into general discovery or a new family outside it.

{{include:instructions/review-family-authority-boundary}}

A new finding is authorized only under one of these Authorization Bases:

- `accepted_family_unvisited_consumer`: an unvisited consumer in an accepted family
- `remediation_regression`: a regression introduced by remediation
- `direct_acceptance_criterion_violation`: a direct acceptance-criterion violation
- `required_consumer_migration`: a consumer migration required to make the changed contract valid

Every new finding candidate must record its Authorization Basis, Reason Absent (why it was absent from the initial review), affected paths, and supporting evidence. Leave tracked-issue identity, family relation, continuity, recurrence, and lifecycle classification to adjudication using the current finding records and verified evidence. Do not restart general discovery in untouched areas or add an adjacent or separate family observed during comparison to new findings or fix scope.

Immediately before issuing APPROVE with no blocking finding, regression-check the presented changed-target list. Do not start new general discovery; confirm that repairs to open findings did not break the changed contracts and that no unvisited consumer remains in an accepted family. Record the checked scope and supporting evidence in the existing verification or evidence fields defined by the output contract.
