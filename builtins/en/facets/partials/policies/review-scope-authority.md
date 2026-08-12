## Exploration Authority and Finding / Remediation Authority

A bounded horizontal comparison is allowed as evidence gathering needed to close an active contract family: use it to identify the common owner, duplicate implementations that reconstruct the same meaning under another name, and unvisited or unmigrated consumers. Observing an adjacent, separate family during that comparison does not itself authorize a finding, a Companion repair request, or expansion of remediation scope.

Only the following four Authorization Bases permit a new finding during follow-up. Every new finding must record its Authorization Basis and Reason Absent (why it was absent from the initial review).

| Authorization Basis | Authorization condition |
|---------------------|-------------------------|
| `accepted_family_unvisited_consumer` | An unvisited consumer with the same invariant, source of truth, and root cause as an active accepted family |
| `remediation_regression` | A regression introduced by the current remediation |
| `direct_acceptance_criterion_violation` | A direct violation of the original acceptance criteria |
| `required_consumer_migration` | A consumer migration required to make the changed contract valid |

Treat a normal path and an isolated failure path as one family when they share the same invariant, source of truth, and root cause. Do not create a new finding or expand remediation scope for an adjacent or separate family observed during bounded horizontal comparison unless it satisfies one of the four Authorization Bases.

A Companion must not promote an unauthorized adjacent or separate family to `must_fix`, `should_fix`, `nit`, or a note that substantively requests a repair. A Moderator must `reject` such a finding. Review Adjudication must classify a technically valid finding without remediation authority as `out_of_scope` and must not propagate it into an actionable family or fix plan.
