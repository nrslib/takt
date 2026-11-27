# Review Adjudication Knowledge

## Reading the Threat Model

A threat model describes who can choose values, whose authority processes them, what they can reach, and what the contract requires protecting. Facts about actors and authority established by code or configuration differ from protection obligations established by requirements, existing contracts, or policies. Absence of a documented threat does not mean safety; an undecided protection obligation also differs from an established exclusion from protection.

{{include:knowledge/applicable-inputs}}

## Environment Roles and Support Contracts

Primary and secondary roles in documentation or knowledge describe development and verification priorities. A CI job, a means of checking, or an implemented path for an environment differs from a promise to support or verify that environment for users. Requirements and the scope promised for the feature in pre-change user-facing documentation establish the support contract. Post-change documentation alone does not establish that the promise existed before the change.

Similar failures can contain both portions caused by environment-specific constraints and portions caused by implementation, configuration, or dependencies shared across environments. Even without the actual device, official specifications, code, and existing verification records using mocks or specification-conforming inputs can establish some portions.

## What Plan, Repair, and Verification Records Establish

A plan establishes the adopted method and intended work; repair results establish applied changes; verification results establish the conditions actually checked and their outcomes. A plan or completion criteria alone do not establish completed application or verification. When a counterexample, change, and verification result correspond to the same execution and code state, those records distinguish resolved conditions from remaining gaps.

Past release and change records establish facts at that time and serve a different purpose from current specifications. Differences from current names or specifications alone do not make historical statements incorrect.

## Observation Scope of Evidence

A correct result differs from intermediate processing meeting design conditions. Limiting output does not establish limits on earlier retrieval, processing, or retention. Scanning all items and holding them all at once are also different properties. Applicable standards and current paths may establish processing properties even without numerical targets or measured incidents.

A defense matters not only by existing but by acting before prohibited results or side effects and preserving necessary normal behavior. Configuration values, internal state, or a success label in verification records establish only conditions those records actually observed. When requirements specify a subsequent effect, observing that effect differs from observing an intermediate value.
