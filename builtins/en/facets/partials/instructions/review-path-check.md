{{include:instructions/contract-path-analysis}}

Review only the authorized range. Within that range, inspect every path involved in changed invariants, established contracts that must remain intact, and regressions caused by repairs. Do not claim coverage beyond the authorized range.

For each authorized problem family, identify the contract authority that permits the judgment from the original requirement, acceptance criteria, public specification, real consumer dependency, or latest adjudication artifact, and name the artifact or location used. During follow-up, also compare every target path with repair-scope evidence to determine whether the remediation created, changed, or exposed it, or whether it is a pre-existing unvisited consumer.

When the latest adjudication artifact defines an accepted family's invariant, responsible source, and reason to change from the same cause, apply that adjudication as contract authority to every direct consumer that current code confirms shares them. A consumer's absence from the adjudication's itemized paths may establish that it was unvisited, but does not establish that it lacks contract authority. Do not reduce an accepted family to only the files named in the adjudication.

Starting from a real entry point, first enumerate the directly reachable consumers and branches. Use the applicable policy criteria to make a finite list of the concrete conditions that must be distinguished as inputs, preconditions, dependency outcomes, and terminal results. Do not add distinctions that the policy excludes, and record evidence for treating a condition as out of scope or unreachable.

For each listed condition, compare the expected terminal result with the actual terminal result using evidence available in the current step. Do not use confirmation of a successful result as confirmation of another condition or combine conditions under a generic label such as "failure paths." Record a condition that cannot be confirmed directly as unchecked, and apply the policy when deciding whether it is a finding.

For each terminal condition, also inspect the smallest test or observation point that would detect it. Distinguish coverage that verifies the expected result, an assertion that pins the incorrect current result as correct, and the absence of coverage. Do not substitute an assertion for another success or failure condition.

During a testing review, follow the test-addition criteria in the testing policy and do not request a duplicate test when an existing test already detects the same observable failure. Internal branch count or implementation path count alone is not grounds for splitting a finding or adding tests.

Before finishing the current review, provide a closure record in the current response for every authorized problem family that makes the following verifiable: contract authority, real entry point, every directly reachable consumer, each contract-distinct condition, causal relationship to the remediation, expected terminal result, actual terminal result, and evidence for anything unchecked or excluded. When an artifact supplies contract authority, identify that artifact rather than summarizing it only as "adjudicated." Do not omit this record merely because a later phase will write the report.
