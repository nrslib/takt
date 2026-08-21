## Exploration Authority and Finding / Remediation Authority

Use the contract-family identity defined by the active role instruction; this authority policy does not redefine it. Names, types, or proximity alone are grounds neither for merging nor for splitting a family.

A bounded horizontal comparison is allowed as evidence gathering needed to close an active contract family: use it to identify the responsible source, duplicate implementations that reconstruct the same meaning under another name, and unvisited or unmigrated consumers. Observing an adjacent, separate family during that comparison does not itself authorize a finding, a Companion repair request, or expansion of remediation scope.

## Authority by Role

| Role | Authorized | Prohibited |
|------|------------|------------|
| Initial review | Initially discover every path in the presented changed families and report confirmed defects | Pre-existing problems with an identity different from the changed family |
| Follow-up review | Check accepted-family unvisited consumers, required migrations, and remediation regressions | Restart general discovery or add an adjacent family |
| Review adjudication | Validate a submitted candidate and its same-family boundary | General initial discovery or a new finding without a candidate |
| Final preservation | Treat unmigrated paths, obsolete paths, one-sided updates, and remediation regressions in an accepted family defined by the original requirements or in a declared actionable family as merge blockers | Discover or add a family absent from both the original requirements and existing adjudication |
| Companion | Report early active-family candidates within the supplied cumulative diff and context | Claim hidden repository paths were verified or request repair of another family |
| Companion Moderator | Accept, merge, downgrade, or reject submitted Companion evidence | Early scan, repository search, new findings, or a family-completion guarantee |

Only the following four Authorization Bases permit a new finding during follow-up or Final preservation. Every new finding must record its Authorization Basis and Reason Absent (why it was absent from the initial review). During Final preservation, treat an accepted family defined by the original requirements or a declared actionable family as the active accepted family and apply the same decision order.

| Authorization Basis | Authorization condition |
|---------------------|-------------------------|
| `remediation_regression` | A defect in an implementation or path created, changed, exposed, or connected by the current remediation |
| `required_consumer_migration` | An unmodified, unexposed, pre-existing consumer that the adjudication, initial review, or remediation plan already identified but whose required migration was not performed |
| `accepted_family_unvisited_consumer` | An unmodified, unexposed, pre-existing consumer omitted from both the initial scan and remediation records of the active accepted family |
| `direct_acceptance_criterion_violation` | A path that matches none of the first three causal classes and directly violates an already presented original acceptance criterion |

Record exactly one primary Authorization Basis for each new finding. Apply this decision order and stop at the first matching condition; do not also assign a later class.

1. Use `remediation_regression` when the current remediation created or changed the implementation, or newly exposed or connected the path.
2. Otherwise, use `required_consumer_migration` for an unchanged existing consumer that the active accepted-family adjudication, initial review, or remediation plan already identified but did not migrate.
3. Otherwise, use `accepted_family_unvisited_consumer` for an unchanged existing consumer that shares the active accepted family's invariant, responsible source, and reason to change from the same cause but was omitted from the initial scan and remediation records.
4. Otherwise, use `direct_acceptance_criterion_violation` for a direct violation sharing the identity of an already presented original acceptance criterion.

An attempted but incomplete consumer repair is `remediation_regression` under step 1 even when that consumer was identified before the remediation. Use `required_consumer_migration` only when the current remediation did not touch the consumer. Confirm the relationship from the repair diff, repair scope, current code, or adjudication artifact rather than from the name or current family membership alone. Other relationships may be rationale or required migration context, but do not record multiple values in the Authorization Basis field.

When one candidate finding contains defect paths with different primary Authorization Bases, split the findings even if they belong to the same family, use the same test file, or share a repair suggestion. Do not keep those paths in one finding and represent them with a single Authorization Basis.

Treat a normal path and an isolated failure path as one family when they share the same invariant, responsible source, and reason to change from the same cause. Do not create a new finding or expand remediation scope for an adjacent or separate family observed during bounded horizontal comparison unless it satisfies one of the four Authorization Bases. `direct_acceptance_criterion_violation` also requires the evidence to share the identity of an acceptance-contract family already presented. A problem that requires a different responsible source or reason to change does not become a new family during final or follow-up review.

A Companion must not promote an unauthorized adjacent or separate family to `must_fix`, `should_fix`, `nit`, or a note that substantively requests a repair. A Moderator must `reject` such a finding. Review Adjudication must classify a technically valid finding without remediation authority as `out_of_scope` and must not propagate it into an actionable family or fix plan.

## Review Mode

The caller-provided mode domain is exactly `initial | follow_up | unspecified`. Do not normalize different casing, aliases, empty strings, or non-string values.

Use an explicit `initial` or `follow_up` mode directly. For `unspecified` or an absent mode, use `initial` when the directly executed reviewer step iteration is `1`, and `follow_up` when it is an integer `2` or greater. An invalid mode, or an unexpanded, non-integer, or less-than-`1` iteration needed for fallback, is `mode_unknown`.

For `mode_unknown`, apply the follow-up authority ceiling: inspect only accepted-family closure, required consumer migrations, and remediation regressions. Do not conduct general initial discovery, report an adjacent family, or APPROVE based on a claim that initial coverage is complete. Record the invalid mode or fallback reason in the evidence.
