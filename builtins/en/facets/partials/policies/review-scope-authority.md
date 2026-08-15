## Exploration Authority and Finding / Remediation Authority

Use the contract-family identity defined by the active role instruction; this authority policy does not redefine it. Names, types, or proximity alone are grounds neither for merging nor for splitting a family.

A bounded horizontal comparison is allowed as evidence gathering needed to close an active contract family: use it to identify the common owner, duplicate implementations that reconstruct the same meaning under another name, and unvisited or unmigrated consumers. Observing an adjacent, separate family during that comparison does not itself authorize a finding, a Companion repair request, or expansion of remediation scope.

## Authority by Role

| Role | Authorized | Prohibited |
|------|------------|------------|
| Initial review | Initially discover every path in the presented changed families and report confirmed defects | Pre-existing problems with an identity different from the changed family |
| Follow-up review | Check accepted-family unvisited consumers, required migrations, and remediation regressions | Restart general discovery or add an adjacent family |
| Review adjudication | Validate a submitted candidate and its same-family boundary | General initial discovery or a new finding without a candidate |
| Final preservation | Treat unmigrated paths, obsolete paths, one-sided updates, and remediation regressions in declared actionable families as merge blockers | Discover or add a new family |
| Companion | Report early active-family candidates within the supplied cumulative diff and context | Claim hidden repository paths were verified or request repair of another family |
| Companion Moderator | Accept, merge, downgrade, or reject submitted Companion evidence | Early scan, repository search, new findings, or a family-completion guarantee |

Only the following four Authorization Bases permit a new finding during follow-up. Every new finding must record its Authorization Basis and Reason Absent (why it was absent from the initial review).

| Authorization Basis | Authorization condition |
|---------------------|-------------------------|
| `accepted_family_unvisited_consumer` | An unvisited consumer with the same invariant, source of truth, and root cause as an active accepted family |
| `remediation_regression` | A regression introduced by the current remediation |
| `direct_acceptance_criterion_violation` | A direct violation of the original acceptance criteria |
| `required_consumer_migration` | A consumer migration required to make the changed contract valid |

Treat a normal path and an isolated failure path as one family when they share the same invariant, source of truth, and root cause. Do not create a new finding or expand remediation scope for an adjacent or separate family observed during bounded horizontal comparison unless it satisfies one of the four Authorization Bases. `direct_acceptance_criterion_violation` also requires the evidence to share the identity of an acceptance-contract family already presented. A problem that requires a new owner or root cause does not become a new family during final or follow-up review.

A Companion must not promote an unauthorized adjacent or separate family to `must_fix`, `should_fix`, `nit`, or a note that substantively requests a repair. A Moderator must `reject` such a finding. Review Adjudication must classify a technically valid finding without remediation authority as `out_of_scope` and must not propagate it into an actionable family or fix plan.

## Review Mode

The caller-provided mode domain is exactly `initial | follow_up | unspecified`. Do not normalize different casing, aliases, empty strings, or non-string values.

Use an explicit `initial` or `follow_up` mode directly. For `unspecified` or an absent mode, use `initial` when the directly executed reviewer step iteration is `1`, and `follow_up` when it is an integer `2` or greater. An invalid mode, or an unexpanded, non-integer, or less-than-`1` iteration needed for fallback, is `mode_unknown`.

For `mode_unknown`, apply the follow-up authority ceiling: inspect only accepted-family closure, required consumer migrations, and remediation regressions. Do not conduct general initial discovery, report an adjacent family, or APPROVE based on a claim that initial coverage is complete. Record the invalid mode or fallback reason in the evidence.
